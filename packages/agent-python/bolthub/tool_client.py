"""The buyer client: call any tool safely, and settle payment transparently
when one is required.

Port of ``@bolthub/pay``'s ``src/buyer/client.ts``. :class:`ToolClient` calls a
tool; free tools pass through untouched. If the result is a
``payment_required`` challenge, it picks an offer it has a payer for, checks
the budget, pays, and retries the call with the proof in
``_meta["ai.bolthub/payment"]``. It is the symmetric counterpart of the
seller-side :class:`bolthub.paywall.Paywall`.

Budget is per asset: ``max_total["sat"]``, ``max_per_call["sat"]``, etc. The
reservation is taken atomically before the payment, so concurrent calls cannot
both pass the check and overspend.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, Sequence

from .budget import Budget
from .errors import PaymentBudgetError, PaymentError
from .paywall import PAYMENT_META_KEY
from .payers import PaymentPayer

__all__ = ["ToolClient", "get_payment_challenge"]

#: Lifecycle stages reported to ``on_stage``.
PAY_STAGES = ("calling", "paying", "retrying")


def get_payment_challenge(result: Optional[Mapping[str, Any]]) -> Optional[dict]:
    """Extract a ``payment_required`` challenge from a tool result, if present."""
    meta = (result or {}).get("_meta") or {}
    raw = meta.get(PAYMENT_META_KEY) if isinstance(meta, Mapping) else None
    if (
        isinstance(raw, dict)
        and raw.get("status") == "payment_required"
        and isinstance(raw.get("offers"), list)
    ):
        return raw
    return None


class ToolClient:
    """Pay-and-retry wrapper for MCP-wire (TPP) tool calls.

    Args:
        payers: Payers in preference order. The first that matches an offer
            and fits the budget wins (see :func:`bolthub.payers.l402_payer`).
        max_total: Per-asset lifetime spend ceiling, e.g. ``{"sat": 10_000}``.
            An unset asset is unlimited.
        max_per_call: Per-asset per-call ceiling. An unset asset is unlimited.
        budget: An external :class:`bolthub.Budget` to draw from instead of
            the client's own accounting. Pass the same instance to several
            clients to enforce ONE spending pool across them. Mutually
            exclusive with ``max_total``/``max_per_call``.
        on_paid: Called with ``{"scheme", "amount", "asset", "resource"}``
            after a successful payment, before the retry.
        on_stage: Lifecycle callback; receives ``"calling"``, ``"paying"``,
            or ``"retrying"``.
    """

    def __init__(
        self,
        payers: Sequence[PaymentPayer],
        *,
        max_total: Optional[Mapping[str, int]] = None,
        max_per_call: Optional[Mapping[str, int]] = None,
        budget: Optional[Budget] = None,
        on_paid: Optional[Callable[[dict], None]] = None,
        on_stage: Optional[Callable[[str], None]] = None,
    ) -> None:
        if not payers:
            raise ValueError("ToolClient: at least one payer is required")
        if budget is not None and (max_total is not None or max_per_call is not None):
            raise ValueError(
                "ToolClient: pass either an external `budget` or "
                "`max_total`/`max_per_call`, not both"
            )
        self._payers = list(payers)
        self._budget = budget if budget is not None else Budget(
            max_total=max_total, max_per_call=max_per_call
        )
        self._on_paid = on_paid
        self._on_stage = on_stage

    def spent_for(self, asset: str) -> float:
        """Total spent so far in ``asset`` (from the shared pool when an external budget is used)."""
        return self._budget.spent_for(asset)

    def remaining_for(self, asset: str) -> float:
        """Remaining budget in ``asset`` (``math.inf`` if none configured)."""
        return self._budget.remaining_for(asset)

    def call(self, caller: Callable[..., "dict[str, Any]"]) -> "dict[str, Any]":
        """Run a tool call through the pay-and-retry loop.

        ``caller(meta=None)`` performs the call, merging ``meta`` into the
        request ``_meta``, and returns the ToolResult dict. Returns the final
        result; if no configured payer matches an offered rail, returns the
        unpaid challenge result so the caller can decide.

        Raises :class:`PaymentBudgetError` when every matching offer exceeds
        the budget, and :class:`PaymentError` when the payment itself fails
        (the reservation is rolled back).
        """
        self._stage("calling")
        first = caller()

        challenge = get_payment_challenge(first)
        if challenge is None:
            return first  # free tool, a real result, or a non-payment error

        selected = self._select_offer(challenge)  # raises PaymentBudgetError if matched-but-unaffordable
        if selected is None:
            return first  # no payer for any offered rail
        payer, offer = selected
        asset = str(offer.get("asset"))
        amount = offer.get("amount")

        self._budget.reserve(asset, amount)  # atomic budget gate, before the payment
        self._stage("paying")
        try:
            paid = payer.pay(offer)
        except Exception as err:
            self._budget.rollback(asset, amount)
            raise PaymentError(
                f"Failed to pay {amount} {asset} via {payer.scheme}: {err}", err
            ) from err

        if self._on_paid is not None:
            self._on_paid(
                {
                    "scheme": payer.scheme,
                    "amount": amount,
                    "asset": asset,
                    "resource": challenge.get("resource"),
                }
            )
        self._stage("retrying")
        return caller({PAYMENT_META_KEY: {"scheme": payer.scheme, "proof": paid["proof"]}})

    def call_tool(
        self, client: Any, name: str, args: Optional[dict] = None
    ) -> "dict[str, Any]":
        """Convenience over :meth:`call` for an MCP-style client.

        ``client`` only needs a ``call_tool(name=..., arguments=..., meta=...)``
        method that sends ``meta`` as the request ``_meta`` and returns the
        ToolResult dict.
        """
        return self.call(
            lambda meta=None: client.call_tool(name=name, arguments=args or {}, meta=meta)
        )

    def _stage(self, stage: str) -> None:
        if self._on_stage is not None:
            self._on_stage(stage)

    def _select_offer(self, challenge: dict) -> "Optional[tuple[PaymentPayer, dict]]":
        """Pick the first payer (in preference order) with a matching, affordable offer."""
        offers = challenge.get("offers") or []
        matched_but_unaffordable = False
        for payer in self._payers:
            offer = next(
                (o for o in offers if isinstance(o, dict) and o.get("scheme") == payer.scheme),
                None,
            )
            if offer is None:
                continue
            if self._budget.check(str(offer.get("asset")), offer.get("amount")):
                matched_but_unaffordable = True
                continue  # a cheaper rail later in the list may still fit
            return payer, offer
        if matched_but_unaffordable:
            offered = ", ".join(
                f"{o.get('amount')} {o.get('asset')}" for o in offers if isinstance(o, dict)
            )
            raise PaymentBudgetError(
                f"All offered rails exceed the budget for their asset (offers: {offered})"
            )
        return None

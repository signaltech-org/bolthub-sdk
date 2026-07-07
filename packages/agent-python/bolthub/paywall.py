"""The seller wrapper: turn any MCP tool handler into a paid one.

Port of ``@bolthub/pay``'s ``src/paywall.ts``. :func:`create_paywall` returns a
:class:`Paywall` whose call wraps a tool handler so it implements the MCP side
of the bolthub Tool Payment Profile (TPP):

- a call with no valid proof returns a ``payment_required`` challenge (one
  offer per rail that can price the tool), carried in
  ``result["_meta"]["ai.bolthub/payment"]`` plus a human-readable error so
  payment-blind clients still see something sensible;
- a call carrying a valid proof in ``extra["_meta"]["ai.bolthub/payment"]``
  runs the real handler.

Framework-agnostic by design: handlers take ``(args, extra)`` and return a
dict-shaped ``ToolResult`` (``{"content": [{"type": "text", "text": ...}],
"isError": ..., "_meta": ...}``), a structural subset of MCP's
``CallToolResult`` — no MCP SDK dependency. Both ``def`` and ``async def``
handlers are supported; the wrapper matches the handler's flavour. Rails stay
synchronous (server-side). See ``docs/specs/tool-payment-profile-v0.md``.
"""

from __future__ import annotations

import inspect
import time
from typing import Any, Callable, Iterable, Optional, Sequence, Union

from .rails import PaymentRail

__all__ = ["create_paywall", "Paywall", "PAYMENT_META_KEY", "SPEC_VERSION"]

#: The reverse-DNS ``_meta`` key that carries TPP challenge/proof envelopes.
PAYMENT_META_KEY = "ai.bolthub/payment"

#: TPP spec version this implementation emits.
SPEC_VERSION = "0.1"

#: Fallback challenge lifetime when no rail reports an offer expiry.
_FALLBACK_CHALLENGE_TTL_MS = 15 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_proof(extra: Optional[dict]) -> Optional[dict]:
    """Read and validate the proof envelope from a request's ``_meta``."""
    meta = (extra or {}).get("_meta") or {}
    raw = meta.get(PAYMENT_META_KEY) if isinstance(meta, dict) else None
    if (
        isinstance(raw, dict)
        and isinstance(raw.get("scheme"), str)
        and isinstance(raw.get("proof"), str)
    ):
        return {"scheme": raw["scheme"], "proof": raw["proof"]}
    return None


def _price_for_rail(rail: PaymentRail, prices: "list[dict]") -> Optional[dict]:
    """The first price a rail can settle, or ``None`` if none match its assets."""
    for price in prices:
        if price["asset"] in rail.assets:
            return price
    return None


def _normalise_prices(
    price: Union[dict, Sequence[dict]], default_asset: str
) -> "list[dict]":
    """Normalise one-or-many prices, applying the default asset and validating amounts."""
    items = list(price) if isinstance(price, (list, tuple)) else [price]
    if not items:
        raise ValueError("paywall: at least one price is required")
    normalised = []
    for p in items:
        asset = p.get("asset")
        normalised.append(
            {"amount": p.get("amount"), "asset": default_asset if asset is None else asset}
        )
    for p in normalised:
        amount = p["amount"]
        if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
            raise ValueError("paywall: every price amount must be a positive integer")
    return normalised


def _challenge_result(challenge: dict, note: Optional[str] = None) -> dict:
    """Wrap a challenge in an MCP error result (human text + machine-readable ``_meta``)."""
    text = (
        (f"{note} " if note else "")
        + f"Payment required: {challenge['price']['amount']} {challenge['price']['asset']} "
        + f"to use \"{challenge['resource']}\". Pay one of the {len(challenge['offers'])} "
        + f'offered method(s) and retry with the proof in _meta["{PAYMENT_META_KEY}"].'
    )
    return {
        "content": [{"type": "text", "text": text}],
        "isError": True,
        "_meta": {PAYMENT_META_KEY: challenge},
    }


class Paywall:
    """A handler-wrapping paywall bound to one or more rails.

    Call the instance itself to wrap a handler, or use :meth:`tool` to register
    a paid tool on an MCP-style server and :meth:`advertise` to build the
    discovery-time advertisement. Build one with :func:`create_paywall`.
    """

    def __init__(
        self,
        rails: Iterable[PaymentRail],
        *,
        default_asset: str = "sat",
        on_paid: Optional[Callable[[dict], None]] = None,
    ) -> None:
        self._rails = list(rails)
        if not self._rails:
            raise ValueError("create_paywall: at least one rail is required")
        self._default_asset = default_asset
        self._on_paid = on_paid
        self._rail_by_scheme = {rail.scheme: rail for rail in self._rails}

    def __call__(
        self,
        handler: Callable,
        *,
        price: Union[dict, Sequence[dict]],
        resource: str,
    ) -> Callable:
        """Wrap ``handler`` so a call must carry a valid payment proof.

        Args:
            handler: The tool handler, ``(args, extra) -> ToolResult`` dict.
                May be ``def`` or ``async def``; the wrapper matches.
            price: ``{"amount": int, "asset": str}`` (``asset`` defaults to the
                paywall's default). Pass a list to price in several assets
                (one per rail).
            resource: Stable, unique id for the thing being sold (e.g. the
                tool name). A proof is accepted **only** for the resource it
                was minted against, so this is required; the wrapper fails
                closed without it. :meth:`tool` fills it in from the tool name.
        """
        if not resource:
            raise ValueError(
                "paywall: `resource` is required — a stable, unique id for this "
                "tool (e.g. its name). Without it, a proof minted for one tool "
                "could unlock another. Use Paywall.tool(...) to default it to "
                "the tool name."
            )
        prices = _normalise_prices(price, self._default_asset)

        def gate(extra: Optional[dict]) -> Optional[dict]:
            """A challenge result to short-circuit with, or ``None`` when paid."""
            proof = _read_proof(extra)
            if proof is None:
                return _challenge_result(self._build_challenge(prices, resource))
            rail = self._rail_by_scheme.get(proof["scheme"])
            if rail is None:
                return _challenge_result(
                    self._build_challenge(prices, resource),
                    f'Unsupported payment scheme "{proof["scheme"]}".',
                )
            rail_price = _price_for_rail(rail, prices)
            if rail_price is None:
                return _challenge_result(
                    self._build_challenge(prices, resource),
                    f'No price configured for scheme "{proof["scheme"]}".',
                )
            result = rail.verify(proof["proof"], resource=resource, price=rail_price)
            if not result.get("ok"):
                return _challenge_result(
                    self._build_challenge(prices, resource),
                    f"Payment proof rejected: {result.get('reason')}.",
                )
            if self._on_paid is not None:
                self._on_paid(
                    {"resource": resource, "scheme": rail.scheme, "amount": result.get("amount")}
                )
            return None

        if inspect.iscoroutinefunction(handler):

            async def wrapped_async(args: dict, extra: Optional[dict] = None) -> dict:
                short_circuit = gate(extra)
                if short_circuit is not None:
                    return short_circuit
                return await handler(args, extra)

            return wrapped_async

        def wrapped(args: dict, extra: Optional[dict] = None) -> dict:
            short_circuit = gate(extra)
            if short_circuit is not None:
                return short_circuit
            return handler(args, extra)

        return wrapped

    def tool(
        self,
        server: Any,
        name: str,
        description: str,
        schema: Any,
        handler: Callable,
        *,
        price: Union[dict, Sequence[dict]],
        resource: Optional[str] = None,
    ) -> None:
        """Register a paid tool on an MCP server, defaulting ``resource`` to ``name``.

        ``server`` only needs a ``tool(name, description, schema, handler)``
        method, so this stays decoupled from any MCP SDK version.
        """
        server.tool(
            name, description, schema, self(handler, price=price, resource=resource or name)
        )

    def advertise(
        self, price: Union[dict, Sequence[dict]], model: str = "per_call"
    ) -> dict:
        """Build the discovery-time TPP payment advertisement for a price."""
        prices = _normalise_prices(price, self._default_asset)
        return {
            "version": SPEC_VERSION,
            "price": prices[0],
            "model": model,
            "rails": [rail.scheme for rail in self._rails],
        }

    def _build_challenge(self, prices: "list[dict]", resource: str) -> dict:
        """Mint a fresh challenge: one offer per rail that can price this resource."""
        offers = []
        for rail in self._rails:
            rail_price = _price_for_rail(rail, prices)
            if rail_price is None:
                continue  # this rail settles none of the tool's priced assets
            try:
                offers.append(rail.create_offer(rail_price, resource))
            except Exception:
                # A rail that can't mint right now (wallet down, etc.) is omitted
                # rather than failing the whole challenge; other rails may work.
                continue
        if not offers:
            raise RuntimeError(f"No configured rail could create an offer for {resource}")
        expiries = [
            offer["expiresAt"]
            for offer in offers
            if isinstance(offer.get("expiresAt"), (int, float))
            and not isinstance(offer.get("expiresAt"), bool)
        ]
        expires_at = min(expiries) if expiries else _now_ms() + _FALLBACK_CHALLENGE_TTL_MS
        # Top-level `price` is the primary (first) price for display; each offer
        # carries its own authoritative amount + asset.
        return {
            "status": "payment_required",
            "version": SPEC_VERSION,
            "price": prices[0],
            "resource": resource,
            "offers": offers,
            "expiresAt": expires_at,
        }


def create_paywall(
    rails: Iterable[PaymentRail],
    *,
    default_asset: str = "sat",
    on_paid: Optional[Callable[[dict], None]] = None,
) -> Paywall:
    """Create a :class:`Paywall` bound to one or more payment rails.

    Args:
        rails: Settlement rails offered to buyers, in preference order.
            At least one (see :func:`bolthub.rails.l402_rail`).
        default_asset: Asset assumed when a price omits one. Defaults to ``"sat"``.
        on_paid: Called with ``{"resource", "scheme", "amount"}`` after a proof
            verifies and before the handler runs.

    Example::

        pay = create_paywall(rails=[l402_rail(secret, invoice_provider)])

        pay.tool(server, "get_satellite_image", "Recent imagery", schema,
                 fetch_image, price={"amount": 2000, "asset": "sat"})
    """
    return Paywall(rails, default_asset=default_asset, on_paid=on_paid)

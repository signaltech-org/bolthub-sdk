"""A per-asset spending budget with atomic reserve/rollback.

Port of ``@bolthub/pay``'s ``src/budget.ts``: one :class:`Budget` can be shared
by several payment paths (e.g. a :class:`bolthub.tool_client.ToolClient` for
MCP-wire payments plus other clients) so that neither can spend past
``max_total``, even under concurrent calls. :meth:`Budget.reserve` performs the
check-and-count atomically under an internal lock; call it *before* paying and
return the reservation with :meth:`Budget.rollback` if the payment then fails.
"""

from __future__ import annotations

import math
import threading
from typing import Any, Mapping, Optional

from .errors import PaymentBudgetError

__all__ = ["Budget"]


class Budget:
    """Per-asset spend accounting with ``max_total`` / ``max_per_call`` limits.

    Args:
        max_total: Per-asset lifetime spend ceiling, e.g. ``{"sat": 10_000}``.
            An unset asset is unlimited.
        max_per_call: Per-asset per-call ceiling. An unset asset is unlimited.

    Thread-safe: :meth:`reserve` and :meth:`rollback` are guarded by an
    internal lock, so concurrent callers can never both pass the budget check
    and then jointly overspend.
    """

    def __init__(
        self,
        *,
        max_total: Optional[Mapping[str, int]] = None,
        max_per_call: Optional[Mapping[str, int]] = None,
    ) -> None:
        self._max_total = dict(max_total or {})
        self._max_per_call = dict(max_per_call or {})
        self._spent: dict[str, float] = {}
        self._lock = threading.Lock()

    def spent_for(self, asset: str) -> float:
        """Total reserved-and-kept so far in ``asset``."""
        return self._spent.get(asset, 0)

    def remaining_for(self, asset: str) -> float:
        """Remaining headroom in ``asset`` (``math.inf`` if no ``max_total`` configured)."""
        maximum = self._max_total.get(asset)
        if maximum is None:
            return math.inf
        return max(0, maximum - self.spent_for(asset))

    def per_call_for(self, asset: str) -> float:
        """The configured per-call ceiling for ``asset`` (``math.inf`` if none)."""
        ceiling = self._max_per_call.get(asset)
        return math.inf if ceiling is None else ceiling

    def check(
        self, asset: str, amount: Any, per_call_override: Optional[float] = None
    ) -> Optional[str]:
        """Pure check; returns the denial reason, or ``None`` when the charge fits.

        ``per_call_override`` tightens (never loosens) the per-call ceiling for
        this one call, e.g. a caller-supplied ``max_cost_sats``.
        """
        if (
            isinstance(amount, bool)
            or not isinstance(amount, (int, float))
            or not math.isfinite(amount)
            or amount <= 0
        ):
            return "invalid offer amount"
        per_call = min(
            self.per_call_for(asset),
            per_call_override if per_call_override is not None else math.inf,
        )
        if amount > per_call:
            return "exceeds per-call cap"
        maximum = self._max_total.get(asset)
        if maximum is not None and self.spent_for(asset) + amount > maximum:
            return "exceeds total budget"
        return None

    def reserve(
        self, asset: str, amount: Any, per_call_override: Optional[float] = None
    ) -> None:
        """Atomic reserve; raises :class:`PaymentBudgetError` when the charge
        doesn't fit. Call before paying; on payment failure, return the
        reservation with :meth:`rollback`.
        """
        with self._lock:
            denial = self.check(asset, amount, per_call_override)
            if denial:
                raise PaymentBudgetError(f"Offer {amount} {asset} {denial}")
            self._spent[asset] = self.spent_for(asset) + amount

    def rollback(self, asset: str, amount: float) -> None:
        """Return a reservation after a failed payment."""
        with self._lock:
            self._spent[asset] = self.spent_for(asset) - amount

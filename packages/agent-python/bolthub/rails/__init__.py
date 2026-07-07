"""Settlement rails for :func:`bolthub.paywall.create_paywall`.

A rail knows how to mint an offer for a price and verify the buyer's proof;
the paywall core never sees rail-specific bytes. Implement the
:class:`PaymentRail` protocol to add a rail without touching the paywall.
Mirrors ``@bolthub/pay``'s ``src/rails/``.
"""

from __future__ import annotations

from typing import Any, Protocol, Sequence, runtime_checkable

from .facilitator import FacilitatorTransport, facilitator_rail, http_facilitator
from .l402 import InvoiceProvider, l402_rail

__all__ = [
    "PaymentRail",
    "InvoiceProvider",
    "FacilitatorTransport",
    "l402_rail",
    "facilitator_rail",
    "http_facilitator",
]


@runtime_checkable
class PaymentRail(Protocol):
    """A settlement rail: mints the offers a buyer pays and verifies their proofs.

    The two halves are symmetric: :meth:`create_offer` mints the challenge a
    buyer pays; :meth:`verify` checks the proof they return.
    """

    #: Scheme id, e.g. ``"l402"``. Must match the proof's ``scheme``.
    scheme: str
    #: Assets this rail can settle, e.g. ``("sat",)``. The paywall uses this
    #: to match one of a tool's prices to a rail.
    assets: Sequence[str]

    def create_offer(self, price: "dict[str, Any]", resource: str) -> "dict[str, Any]":
        """Build a concrete offer dict for ``price``, bound to ``resource``.

        ``scheme``, ``amount``, and ``asset`` are common offer fields;
        everything else (invoice, token, ...) is rail-specific.
        """
        ...

    def verify(
        self, proof: str, *, resource: str, price: "dict[str, Any]"
    ) -> "dict[str, Any]":
        """Verify a buyer's ``proof`` string was minted for ``resource`` at ``price``.

        Returns ``{"ok": True, "resource": ..., "amount": ...}`` or
        ``{"ok": False, "reason": ...}``.
        """
        ...

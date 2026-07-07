"""Buyer-side payers for :class:`bolthub.tool_client.ToolClient`.

A payer is the buyer-side counterpart of a rail: it pays an offer of one
scheme and returns the proof to present on retry. Implement the
:class:`PaymentPayer` protocol to support another rail.
Mirrors ``@bolthub/pay``'s ``src/payers/``.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from .l402 import L402Payer, l402_payer

__all__ = ["PaymentPayer", "L402Payer", "l402_payer"]


@runtime_checkable
class PaymentPayer(Protocol):
    """Pays an offer of one scheme and returns the proof for the retry."""

    #: Scheme id this payer settles, matching the offer's ``scheme``.
    scheme: str

    def pay(self, offer: "dict[str, Any]") -> "dict[str, Any]":
        """Pay ``offer`` and return ``{"proof": str, "amount": ..., "asset": ...}``."""
        ...

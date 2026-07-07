"""Buyer-side L402 payer: pay the offer's Lightning invoice and return the
``<token>:<preimage>`` proof. Mirrors ``@bolthub/pay``'s ``l402Payer``.
"""

from __future__ import annotations

from typing import Any

from ..wallets import WalletAdapter

__all__ = ["L402Payer", "l402_payer"]


class L402Payer:
    """The L402 payment payer. Build one with :func:`l402_payer`."""

    scheme = "l402"

    def __init__(self, wallet: WalletAdapter) -> None:
        self._wallet = wallet

    def pay(self, offer: "dict[str, Any]") -> "dict[str, Any]":
        invoice = offer.get("invoice")
        token = offer.get("token")
        if not isinstance(invoice, str) or not invoice or not isinstance(token, str) or not token:
            raise ValueError("l402 offer is missing `invoice` or `token`")
        preimage = self._wallet.pay_invoice(invoice)
        if not preimage:
            raise RuntimeError("wallet returned an empty preimage")
        return {
            "proof": f"{token}:{preimage}",
            "amount": offer.get("amount"),
            "asset": str(offer.get("asset")),
        }


def l402_payer(wallet: WalletAdapter) -> L402Payer:
    """Build the L402 payer.

    Args:
        wallet: Anything that can pay a BOLT11 invoice and return its preimage
            hex — the same :class:`bolthub.wallets.WalletAdapter` the HTTP
            :class:`bolthub.L402Client` uses, so ``NwcWallet``, ``LndWallet``,
            ``PhoenixdWallet``, etc. drop straight in.
    """
    return L402Payer(wallet)

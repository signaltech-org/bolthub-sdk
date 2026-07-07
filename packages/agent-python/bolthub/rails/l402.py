"""The Lightning / L402 settlement rail for :func:`bolthub.paywall.create_paywall`.

Mints a BOLT11 invoice + HMAC-signed token per offer and verifies
``<token>:<preimage>`` proofs. Wire-compatible with the bolthub gateway's L402
scheme and with ``@bolthub/pay``'s ``l402Rail``, so a tool paywalled with this
rail and an endpoint behind the gateway speak the same bytes.
"""

from __future__ import annotations

import time
from typing import Any, Protocol, Tuple, runtime_checkable

from ..token import sign_l402_token, verify_l402_token, verify_preimage

__all__ = ["InvoiceProvider", "L402Rail", "l402_rail"]

_DEFAULT_TTL_SECONDS = 15 * 60


@runtime_checkable
class InvoiceProvider(Protocol):
    """Creates the Lightning invoice that backs an L402 offer.

    Wrap your own wallet (NWC / LND / phoenixd / LNbits) or a bolthub-hosted
    facilitator.
    """

    def create_invoice(self, amount_sat: int, memo: str) -> Tuple[str, str]:
        """Create an invoice for ``amount_sat``.

        Returns ``(bolt11_invoice, payment_hash_hex)`` — the payment hash the
        buyer's revealed preimage must hash to.
        """
        ...


class L402Rail:
    """The L402 payment rail. Build one with :func:`l402_rail`."""

    scheme = "l402"
    assets = ("sat",)

    def __init__(
        self,
        secret: str,
        invoice_provider: InvoiceProvider,
        *,
        ttl_seconds: int = _DEFAULT_TTL_SECONDS,
    ) -> None:
        if not secret or len(secret) < 32:
            raise ValueError("l402_rail: `secret` must be at least 32 bytes")
        self._secret = secret
        self._invoice_provider = invoice_provider
        self._ttl_ms = ttl_seconds * 1000

    def create_offer(self, price: "dict[str, Any]", resource: str) -> "dict[str, Any]":
        if price["asset"] != "sat":
            raise ValueError(f"l402_rail settles in \"sat\", not \"{price['asset']}\"")
        invoice, payment_hash = self._invoice_provider.create_invoice(
            price["amount"], f"bolthub: {resource}"
        )
        expires_at = int(time.time() * 1000) + self._ttl_ms
        token = sign_l402_token(
            self._secret,
            {"paymentHash": payment_hash, "resource": resource, "expiresAt": expires_at},
        )
        return {
            "scheme": "l402",
            "amount": price["amount"],
            "asset": "sat",
            "token": token,
            "invoice": invoice,
            "expiresAt": expires_at,
            # The exact header a gateway/origin would emit over HTTP, included so
            # an HTTP-native buyer can reuse one parser across transports.
            "wwwAuthenticate": f'L402 macaroon="{token}", invoice="{invoice}"',
        }

    def verify(
        self, proof: str, *, resource: str, price: "dict[str, Any]"
    ) -> "dict[str, Any]":
        # Proof is `<token>:<preimage>`. The token (base64url + "." + hex sig)
        # and the preimage (hex) contain no ":", so split on the last colon.
        sep = proof.rfind(":")
        if sep <= 0 or sep == len(proof) - 1:
            return {"ok": False, "reason": "malformed l402 proof"}
        token = proof[:sep]
        preimage = proof[sep + 1 :]

        verified = verify_l402_token(self._secret, token)
        if not verified["ok"]:
            return {"ok": False, "reason": verified["reason"]}
        payload = verified["payload"]
        if payload.get("resource") != resource:
            return {"ok": False, "reason": "proof scoped to a different resource"}
        if not verify_preimage(preimage, payload["paymentHash"]):
            return {"ok": False, "reason": "preimage does not match the invoice"}
        return {"ok": True, "resource": resource, "amount": price["amount"]}


def l402_rail(
    secret: str,
    invoice_provider: InvoiceProvider,
    *,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> L402Rail:
    """Build the L402 payment rail.

    Args:
        secret: HMAC secret used to sign and verify L402 tokens. MUST be at
            least 32 bytes and kept private; anyone with it can mint tokens.
            Pass the same secret you verify with; rotate by re-issuing under a
            new secret.
        invoice_provider: Creates the Lightning invoice that backs each offer.
        ttl_seconds: Token lifetime in seconds. Default 900 (15 min), matching
            the gateway.
    """
    return L402Rail(secret, invoice_provider, ttl_seconds=ttl_seconds)

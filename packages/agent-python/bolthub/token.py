"""L402 token + preimage primitives, wire-compatible with the bolthub gateway
and the TypeScript ``@bolthub/pay`` package (``src/token.ts``).

A token is ``base64url(json(payload)) + "." + hex(HMAC_SHA256(secret, "l402:" + encoded))``.
The buyer pays the invoice bound to ``payload["paymentHash"]``, then presents
``<token>:<preimageHex>``; the seller checks the signature, the expiry, and that
``SHA256(preimage) == paymentHash``. All comparisons are constant-time.

Byte-for-byte compatibility notes: the payload is serialized like JavaScript's
``JSON.stringify`` (compact separators, no ASCII escaping, keys in the order
``paymentHash``, ``resource``, ``expiresAt``) and base64url-encoded without
padding, so a token signed here is identical to one signed by ``@bolthub/pay``
for the same payload and secret. Uses only the standard library.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from typing import Any, Mapping, Optional

__all__ = [
    "sign_l402_token",
    "verify_l402_token",
    "verify_preimage",
    "sha256_hex",
    "random_preimage",
]

#: Domain-separation prefix for L402 tokens (matches the gateway).
_DOMAIN_L402 = "l402"

_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")


def _hmac_hex(secret: str, domain: str, data: str) -> str:
    return hmac.new(
        secret.encode("utf-8"), f"{domain}:{data}".encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _safe_equal(a: str, b: str) -> bool:
    """Constant-time compare of two equal-length strings (case-sensitive)."""
    if len(a) != len(b) or len(a) == 0:
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _b64url_encode(data: bytes) -> str:
    """base64url without padding, matching Node's ``Buffer.toString("base64url")``."""
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(encoded: str) -> bytes:
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


def _hex_to_bytes(hex_str: str, expected_bytes: Optional[int] = None) -> Optional[bytes]:
    """Decode hex to bytes, returning ``None`` on malformed or wrong-length input."""
    if (
        not isinstance(hex_str, str)
        or len(hex_str) == 0
        or len(hex_str) % 2 != 0
        or not _HEX_RE.match(hex_str)
    ):
        return None
    buf = bytes.fromhex(hex_str)
    if expected_bytes is not None and len(buf) != expected_bytes:
        return None
    return buf


def sign_l402_token(secret: str, payload: Mapping[str, Any]) -> str:
    """Sign a payload into an L402 token.

    ``payload`` must carry ``paymentHash`` (hex SHA-256 the buyer's preimage
    must hash to), ``resource`` (what the token is scoped to, e.g. a tool
    name), and ``expiresAt`` (Unix milliseconds). The payload is re-serialized
    in that canonical key order so the token string matches ``@bolthub/pay``'s
    ``signL402Token`` byte-for-byte.
    """
    expires_at = payload["expiresAt"]
    if isinstance(expires_at, float) and expires_at.is_integer():
        expires_at = int(expires_at)  # JSON.stringify prints integral doubles without ".0"
    canonical = {
        "paymentHash": payload["paymentHash"],
        "resource": payload["resource"],
        "expiresAt": expires_at,
    }
    encoded = _b64url_encode(
        json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    return f"{encoded}.{_hmac_hex(secret, _DOMAIN_L402, encoded)}"


def verify_l402_token(
    secret: str, token: str, now: Optional[int] = None
) -> "dict[str, Any]":
    """Verify an L402 token's signature and expiry.

    Returns ``{"ok": True, "payload": {...}}`` or ``{"ok": False, "reason": str}``,
    mirroring ``@bolthub/pay``'s ``verifyL402Token``. A non-future or missing
    ``expiresAt`` is rejected (defence in depth: :func:`sign_l402_token` always
    stamps one, so a token without it is malformed or tampered).

    Args:
        secret: The HMAC secret the token was signed with.
        token: ``<base64url(payload)>.<hex signature>``.
        now: Override the clock in Unix milliseconds (testing). Defaults to
            the current time.
    """
    dot = token.rfind(".")
    if dot <= 0 or dot == len(token) - 1:
        return {"ok": False, "reason": "malformed token"}

    encoded = token[:dot]
    sig = token[dot + 1 :]
    if not _safe_equal(_hmac_hex(secret, _DOMAIN_L402, encoded), sig):
        return {"ok": False, "reason": "bad signature"}

    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception:
        return {"ok": False, "reason": "undecodable payload"}

    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("paymentHash"), str)
        or not payload["paymentHash"]
        or not payload.get("resource")
    ):
        return {"ok": False, "reason": "incomplete payload"}
    expires_at = payload.get("expiresAt")
    if (
        isinstance(expires_at, bool)
        or not isinstance(expires_at, (int, float))
        or not expires_at > 0
    ):
        return {"ok": False, "reason": "missing expiresAt"}
    if now is None:
        now = int(time.time() * 1000)
    if now > expires_at:
        return {"ok": False, "reason": "token expired"}
    return {"ok": True, "payload": payload}


def verify_preimage(preimage_hex: str, payment_hash_hex: str) -> bool:
    """Constant-time check that ``SHA256(preimage) == payment_hash``.

    Both must be 32-byte hex strings. Mirrors the gateway's ``VerifyPreimage``.
    """
    preimage = _hex_to_bytes(preimage_hex, 32)
    expected = _hex_to_bytes(payment_hash_hex, 32)
    if preimage is None or expected is None:
        return False
    return hmac.compare_digest(hashlib.sha256(preimage).digest(), expected)


def sha256_hex(hex_str: str) -> str:
    """Hex SHA-256 of a hex-encoded input. Convenience for invoice providers/tests."""
    buf = _hex_to_bytes(hex_str)
    if buf is None:
        raise ValueError("sha256_hex: input must be non-empty even-length hex")
    return hashlib.sha256(buf).hexdigest()


def random_preimage() -> str:
    """A random 32-byte preimage, hex-encoded. Useful for mock invoice providers and demos."""
    return secrets.token_hex(32)

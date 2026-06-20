"""Nostr Wallet Connect (NIP-47) client for paying invoices.

Implements the ``pay_invoice`` request/response over a relay websocket, with
NIP-04 encryption (AES-256-CBC via ``cryptography``) and BIP-340 event signing
(via the vendored :mod:`bolthub._secp256k1`). Both sync and async transports are
provided. The heavy optional dependencies (``websockets``, ``cryptography``) are
imported lazily so the rest of the SDK works without the ``nwc`` extra.

Security: the connection secret key, the NIP-04 shared secret, and the payment
preimage are never logged.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import _secp256k1
from ._engine import L402Error

NWC_REQUEST_KIND = 23194
NWC_RESPONSE_KIND = 23195

_MISSING = (
    "Nostr Wallet Connect support requires the optional 'nwc' extra. "
    "Install it with: pip install 'bolthub[nwc]'"
)


@dataclass
class NwcConfig:
    """Parsed ``nostr+walletconnect://`` connection parameters."""

    wallet_pubkey: str  # 32-byte hex x-only pubkey of the wallet service
    relay: str          # wss:// (or ws://) relay URL
    secret: str         # 32-byte hex client secret key


def parse_nwc_uri(uri: str) -> NwcConfig:
    """Parse a ``nostr+walletconnect://<pubkey>?relay=..&secret=..`` URI."""
    parsed = urlparse(uri)
    if parsed.scheme != "nostr+walletconnect":
        raise L402Error(
            "Invalid NWC URI: expected scheme 'nostr+walletconnect'"
        )
    # The wallet pubkey is the URI 'host' (netloc); fall back to path for
    # parsers that route it there.
    wallet_pubkey = (parsed.netloc or parsed.path.lstrip("/")).lower()
    query = parse_qs(parsed.query)
    relays = query.get("relay", [])
    secrets = query.get("secret", [])
    if not _is_hex32(wallet_pubkey):
        raise L402Error("Invalid NWC URI: wallet pubkey must be 32-byte hex")
    if not relays:
        raise L402Error("Invalid NWC URI: missing 'relay' parameter")
    if not secrets or not _is_hex32(secrets[0].lower()):
        raise L402Error("Invalid NWC URI: 'secret' must be 32-byte hex")
    return NwcConfig(wallet_pubkey=wallet_pubkey, relay=relays[0], secret=secrets[0].lower())


def _is_hex32(s: str) -> bool:
    if len(s) != 64:
        return False
    try:
        bytes.fromhex(s)
        return True
    except ValueError:
        return False


# ----------------------------------------------------------------- crypto

def _aes():
    try:
        from cryptography.hazmat.primitives import padding
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as e:  # pragma: no cover - exercised via from_uri
        raise ImportError(_MISSING) from e
    return Cipher, algorithms, modes, padding


def _nip04_encrypt(plaintext: str, shared_key: bytes) -> str:
    Cipher, algorithms, modes, padding = _aes()
    iv = os.urandom(16)
    padder = padding.PKCS7(128).padder()
    data = padder.update(plaintext.encode()) + padder.finalize()
    enc = Cipher(algorithms.AES(shared_key), modes.CBC(iv)).encryptor()
    ct = enc.update(data) + enc.finalize()
    return base64.b64encode(ct).decode() + "?iv=" + base64.b64encode(iv).decode()


def _nip04_decrypt(content: str, shared_key: bytes) -> str:
    Cipher, algorithms, modes, padding = _aes()
    if "?iv=" not in content:
        raise L402Error("Malformed NIP-04 ciphertext")
    ct_b64, iv_b64 = content.split("?iv=", 1)
    ct = base64.b64decode(ct_b64)
    iv = base64.b64decode(iv_b64)
    dec = Cipher(algorithms.AES(shared_key), modes.CBC(iv)).decryptor()
    data = dec.update(ct) + dec.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return (unpadder.update(data) + unpadder.finalize()).decode()


def _event_id(event: dict) -> str:
    serialized = json.dumps(
        [0, event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"]],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def build_request_event(config: NwcConfig, bolt11: str) -> tuple[dict, str]:
    """Build a signed, NIP-04-encrypted ``pay_invoice`` request event."""
    sk = bytes.fromhex(config.secret)
    our_pub = _secp256k1.pubkey_gen(sk).hex()
    shared = _secp256k1.ecdh_x(sk, bytes.fromhex(config.wallet_pubkey))
    payload = json.dumps(
        {"method": "pay_invoice", "params": {"invoice": bolt11}},
        separators=(",", ":"),
    )
    event: dict[str, Any] = {
        "pubkey": our_pub,
        "created_at": int(time.time()),
        "kind": NWC_REQUEST_KIND,
        "tags": [["p", config.wallet_pubkey]],
        "content": _nip04_encrypt(payload, shared),
    }
    event_id = _event_id(event)
    event["id"] = event_id
    event["sig"] = _secp256k1.schnorr_sign(bytes.fromhex(event_id), sk, os.urandom(32)).hex()
    return event, event_id


def parse_response_event(event: dict, config: NwcConfig) -> str:
    """Validate, decrypt, and extract the preimage from a 23195 response."""
    if event.get("pubkey") != config.wallet_pubkey:
        raise L402Error("NWC response from an unexpected pubkey")
    if not _verify_event(event):
        raise L402Error("NWC response event signature is invalid")

    shared = _secp256k1.ecdh_x(bytes.fromhex(config.secret), bytes.fromhex(config.wallet_pubkey))
    try:
        data = json.loads(_nip04_decrypt(event.get("content", ""), shared))
    except L402Error:
        raise
    except Exception as e:
        raise L402Error("Failed to decrypt NWC response") from e

    if data.get("error"):
        err = data["error"] or {}
        raise L402Error(
            f"NWC wallet error: {err.get('code', 'UNKNOWN')}: {err.get('message', '')}"
        )
    preimage = (data.get("result") or {}).get("preimage")
    if not preimage:
        raise L402Error("NWC response missing preimage")
    return preimage


def _verify_event(event: dict) -> bool:
    try:
        if event.get("id") != _event_id(event):
            return False
        return _secp256k1.schnorr_verify(
            bytes.fromhex(event["id"]),
            bytes.fromhex(event["pubkey"]),
            bytes.fromhex(event["sig"]),
        )
    except Exception:
        return False


def _subscription_filter(config: NwcConfig, event_id: str) -> dict:
    return {
        "kinds": [NWC_RESPONSE_KIND],
        "authors": [config.wallet_pubkey],
        "#e": [event_id],
    }


# --------------------------------------------------------------- transport

def pay_invoice_sync(config: NwcConfig, bolt11: str, timeout: float) -> str:
    """Pay an invoice over NWC using a synchronous relay websocket."""
    try:
        from websockets.sync.client import connect
    except ImportError as e:
        raise ImportError(_MISSING) from e

    event, event_id = build_request_event(config, bolt11)
    subid = "bolthub-" + event_id[:16]
    deadline = time.monotonic() + timeout

    with connect(config.relay, open_timeout=timeout) as ws:
        ws.send(json.dumps(["REQ", subid, _subscription_filter(config, event_id)]))
        ws.send(json.dumps(["EVENT", event]))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise L402Error("NWC payment timed out waiting for wallet response")
            try:
                raw = ws.recv(timeout=remaining)
            except TimeoutError as e:
                raise L402Error("NWC payment timed out waiting for wallet response") from e
            preimage = _handle_message(raw, subid, config)
            if preimage is not None:
                return preimage


async def pay_invoice_async(config: NwcConfig, bolt11: str, timeout: float) -> str:
    """Pay an invoice over NWC using an async relay websocket."""
    import asyncio

    try:
        import websockets
    except ImportError as e:
        raise ImportError(_MISSING) from e

    event, event_id = build_request_event(config, bolt11)
    subid = "bolthub-" + event_id[:16]

    async def _run() -> str:
        async with websockets.connect(config.relay) as ws:
            await ws.send(json.dumps(["REQ", subid, _subscription_filter(config, event_id)]))
            await ws.send(json.dumps(["EVENT", event]))
            while True:
                raw = await ws.recv()
                preimage = _handle_message(raw, subid, config)
                if preimage is not None:
                    return preimage

    try:
        return await asyncio.wait_for(_run(), timeout=timeout)
    except asyncio.TimeoutError as e:
        raise L402Error("NWC payment timed out waiting for wallet response") from e


def _handle_message(raw: Any, subid: str, config: NwcConfig) -> str | None:
    """Return a preimage for a matching response, else None for messages to skip.

    Raises L402Error on relay/wallet errors.
    """
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(msg, list) or not msg:
        return None
    kind = msg[0]
    if kind == "EVENT" and len(msg) >= 3 and msg[1] == subid:
        return parse_response_event(msg[2], config)
    if kind == "CLOSED" and len(msg) >= 2 and msg[1] == subid:
        reason = msg[2] if len(msg) >= 3 else ""
        raise L402Error(f"NWC relay closed the subscription: {reason}")
    if kind == "NOTICE":
        return None
    return None  # OK / EOSE / unrelated EVENT

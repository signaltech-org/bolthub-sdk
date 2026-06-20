"""Lightning wallet adapters for the L402 client."""

from __future__ import annotations

import base64
from typing import Callable, Protocol, runtime_checkable

import httpx


@runtime_checkable
class WalletAdapter(Protocol):
    """Interface that any Lightning wallet must implement.

    Supply a built-in adapter (``LndWallet``, ``LnbitsWallet``, etc.) or
    provide your own object that satisfies this protocol.
    """

    def pay_invoice(self, bolt11: str) -> str:
        """Pay a BOLT-11 invoice and return the preimage hex string."""
        ...


class LndWallet:
    """Wallet adapter that pays invoices through an LND node's REST API.

    Args:
        host: LND REST endpoint, e.g. ``https://localhost:8080``.
        macaroon: Hex-encoded admin macaroon with send permission.
        timeout_seconds: Payment timeout passed to LND. Defaults to 30.
    """

    def __init__(self, host: str, macaroon: str, timeout_seconds: int = 30):
        self._host = host.rstrip("/")
        self._macaroon = macaroon
        self._timeout = timeout_seconds

    def pay_invoice(self, bolt11: str) -> str:
        resp = httpx.post(
            f"{self._host}/v2/router/send",
            headers={
                "Grpc-Metadata-macaroon": self._macaroon,
                "Content-Type": "application/json",
            },
            json={
                "payment_request": bolt11,
                "timeout_seconds": self._timeout,
            },
            timeout=self._timeout + 5,
        )
        resp.raise_for_status()
        data = resp.json()
        preimage = data.get("result", {}).get("payment_preimage")
        if not preimage:
            raise RuntimeError("LND payment response missing preimage")
        return preimage


class LnbitsWallet:
    """Wallet adapter that pays invoices through an LNbits instance.

    Args:
        url: LNbits base URL, e.g. ``https://lnbits.example.com``.
        admin_key: Admin API key with outgoing payment permission.
    """

    def __init__(self, url: str, admin_key: str):
        self._url = url.rstrip("/")
        self._admin_key = admin_key

    def pay_invoice(self, bolt11: str) -> str:
        resp = httpx.post(
            f"{self._url}/api/v1/payments",
            headers={
                "X-Api-Key": self._admin_key,
                "Content-Type": "application/json",
            },
            json={"out": True, "bolt11": bolt11},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        preimage = data.get("preimage") or data.get("payment_preimage")
        if not preimage:
            raise RuntimeError("LNbits payment response missing preimage")
        return preimage


class PhoenixdWallet:
    """Wallet adapter for Phoenixd (ACINQ). Uses HTTP Basic auth.

    Args:
        url: Phoenixd HTTP base URL, e.g. ``http://localhost:9740``.
        password: HTTP password used for Basic authentication.
        timeout_seconds: Payment request timeout. Defaults to 35.
    """

    def __init__(self, url: str, password: str, timeout_seconds: int = 35):
        self._url = url.rstrip("/")
        self._auth = "Basic " + base64.b64encode(f":{password}".encode()).decode()
        self._timeout = timeout_seconds

    def pay_invoice(self, bolt11: str) -> str:
        resp = httpx.post(
            f"{self._url}/payinvoice",
            headers={"Authorization": self._auth},
            data={"invoice": bolt11},
            timeout=self._timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        preimage = data.get("paymentPreimage")
        if not preimage:
            raise RuntimeError("Phoenixd payment response missing preimage")
        return preimage


class NwcWallet:
    """Wallet adapter for Nostr Wallet Connect (NIP-47).

    Use :meth:`from_uri` to configure from a ``nostr+walletconnect://`` URI (the
    recommended path; requires the ``bolthub[nwc]`` extra), or pass a ``pay_fn``
    callback that receives a BOLT11 invoice and returns the preimage hex string.
    """

    def __init__(self, pay_fn: Callable[[str], str]):
        self._pay_fn = pay_fn

    @classmethod
    def from_uri(cls, uri: str, *, timeout: float = 30.0) -> "NwcWallet":
        """Build a wallet from a ``nostr+walletconnect://`` connection URI.

        Implements NIP-47 ``pay_invoice`` over the relay websocket. Requires the
        optional ``bolthub[nwc]`` extra (``websockets`` + ``cryptography``);
        a clear ``ImportError`` is raised if it is missing.

        Args:
            uri: ``nostr+walletconnect://<wallet_pubkey>?relay=<wss>&secret=<hex>``
            timeout: seconds to wait for the wallet's payment response.
        """
        from . import _nwc

        config = _nwc.parse_nwc_uri(uri)

        def pay_fn(bolt11: str) -> str:
            return _nwc.pay_invoice_sync(config, bolt11, timeout)

        return cls(pay_fn)

    def pay_invoice(self, bolt11: str) -> str:
        return self._pay_fn(bolt11)

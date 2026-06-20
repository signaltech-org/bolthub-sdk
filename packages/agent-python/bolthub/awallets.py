"""Async Lightning wallet adapters for the async L402 client.

Mirror the synchronous adapters in :mod:`bolthub.wallets` but use
``httpx.AsyncClient``. :class:`SyncWalletAdapter` lets any existing synchronous
:class:`~bolthub.wallets.WalletAdapter` run under the async client by paying in a
worker thread.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any, Protocol, runtime_checkable

import httpx

from .wallets import WalletAdapter


@runtime_checkable
class AsyncWalletAdapter(Protocol):
    """Interface for a wallet that pays invoices asynchronously."""

    async def pay_invoice(self, bolt11: str) -> str:
        """Pay a BOLT-11 invoice and return the preimage hex string."""
        ...


class SyncWalletAdapter:
    """Adapt a synchronous :class:`WalletAdapter` to the async interface by
    running its ``pay_invoice`` in a worker thread, so existing wallets work
    unchanged under :class:`~bolthub.aclient.AsyncL402Client`.
    """

    def __init__(self, wallet: WalletAdapter) -> None:
        self._wallet = wallet

    async def pay_invoice(self, bolt11: str) -> str:
        return await asyncio.to_thread(self._wallet.pay_invoice, bolt11)


class AsyncNwcWallet:
    """Async wallet adapter for Nostr Wallet Connect (NIP-47).

    Use :meth:`from_uri` to configure from a ``nostr+walletconnect://`` URI. The
    NIP-47 ``pay_invoice`` request runs over an async relay websocket. Requires
    the ``bolthub[nwc]`` extra.
    """

    def __init__(self, config: Any) -> None:
        self._config = config
        self._timeout = 30.0

    @classmethod
    def from_uri(cls, uri: str, *, timeout: float = 30.0) -> "AsyncNwcWallet":
        from . import _nwc

        wallet = cls(_nwc.parse_nwc_uri(uri))
        wallet._timeout = timeout
        return wallet

    async def pay_invoice(self, bolt11: str) -> str:
        from . import _nwc

        return await _nwc.pay_invoice_async(self._config, bolt11, self._timeout)


class AsyncLndWallet:
    """Async adapter that pays invoices through an LND node's REST API.

    See :class:`bolthub.wallets.LndWallet` for argument semantics.
    """

    def __init__(self, host: str, macaroon: str, timeout_seconds: int = 30):
        self._host = host.rstrip("/")
        self._macaroon = macaroon
        self._timeout = timeout_seconds

    async def pay_invoice(self, bolt11: str) -> str:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._host}/v2/router/send",
                headers={
                    "Grpc-Metadata-macaroon": self._macaroon,
                    "Content-Type": "application/json",
                },
                json={"payment_request": bolt11, "timeout_seconds": self._timeout},
                timeout=self._timeout + 5,
            )
        resp.raise_for_status()
        data = resp.json()
        preimage = data.get("result", {}).get("payment_preimage")
        if not preimage:
            raise RuntimeError("LND payment response missing preimage")
        return preimage


class AsyncLnbitsWallet:
    """Async adapter that pays invoices through an LNbits instance.

    See :class:`bolthub.wallets.LnbitsWallet` for argument semantics.
    """

    def __init__(self, url: str, admin_key: str):
        self._url = url.rstrip("/")
        self._admin_key = admin_key

    async def pay_invoice(self, bolt11: str) -> str:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._url}/api/v1/payments",
                headers={"X-Api-Key": self._admin_key, "Content-Type": "application/json"},
                json={"out": True, "bolt11": bolt11},
                timeout=30,
            )
        resp.raise_for_status()
        data = resp.json()
        preimage = data.get("preimage") or data.get("payment_preimage")
        if not preimage:
            raise RuntimeError("LNbits payment response missing preimage")
        return preimage


class AsyncPhoenixdWallet:
    """Async adapter for Phoenixd (ACINQ). Uses HTTP Basic auth.

    See :class:`bolthub.wallets.PhoenixdWallet` for argument semantics.
    """

    def __init__(self, url: str, password: str, timeout_seconds: int = 35):
        self._url = url.rstrip("/")
        self._auth = "Basic " + base64.b64encode(f":{password}".encode()).decode()
        self._timeout = timeout_seconds

    async def pay_invoice(self, bolt11: str) -> str:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
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

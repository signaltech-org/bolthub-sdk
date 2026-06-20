"""Async L402 HTTP client, mirroring :class:`bolthub.client.L402Client`."""

from __future__ import annotations

import inspect
import time
from typing import Any

import httpx

from ._engine import (
    BudgetTracker,
    L402Error,
    extract_amount,
    parse_challenge,
    response_amount_sats,
    session_key,
    update_session,
)
from .awallets import SyncWalletAdapter
from .client import _SessionInfo
from .session_store import InMemorySessionStore, SessionStore

__all__ = ["AsyncL402Client"]


def _ensure_async_wallet(wallet: Any) -> Any:
    """Return an async wallet: pass async wallets through, wrap sync ones so
    their blocking ``pay_invoice`` runs in a worker thread.
    """
    pay = getattr(wallet, "pay_invoice", None)
    if inspect.iscoroutinefunction(pay):
        return wallet
    return SyncWalletAdapter(wallet)


class AsyncL402Client:
    """Async counterpart of :class:`L402Client`, built on ``httpx.AsyncClient``.

    Same constructor arguments and the same session, budget, and
    unknown-amount semantics. A synchronous ``WalletAdapter`` is accepted and
    automatically run in a worker thread, so existing wallets work unchanged::

        async with AsyncL402Client(LndWallet(...), budget_sats=10_000) as client:
            resp = await client.get("https://acme.gw.bolthub.ai/v1/data")

    Thread/Task safety matches :class:`L402Client`: budget accounting is atomic,
    so the budget is always exact and never exceeded under concurrent tasks.
    """

    def __init__(
        self,
        wallet: Any,
        *,
        max_per_request_sats: int | None = None,
        budget_sats: int | None = None,
        timeout: float = 30.0,
        session_store: SessionStore | None = None,
        on_unknown_amount: str = "cap",
        price_header: str | None = None,
    ):
        self._wallet = _ensure_async_wallet(wallet)
        self._budget_tracker = BudgetTracker(
            max_per_request_sats=max_per_request_sats,
            budget_sats=budget_sats,
            on_unknown_amount=on_unknown_amount,
        )
        self._price_header = price_header
        self._timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout)
        self._store: SessionStore = session_store or InMemorySessionStore()

    @property
    def total_spent(self) -> int:
        """Total satoshis spent across all requests since construction."""
        return self._budget_tracker.total_spent

    @property
    def remaining_budget(self) -> int | None:
        """Satoshis remaining, or ``None`` if no budget was set."""
        return self._budget_tracker.remaining_budget

    def get_sessions(self) -> dict[str, _SessionInfo]:
        """Return a snapshot of all cached session tokens."""
        return {
            k: _SessionInfo(token=s.token, expires_at=s.expires_at, balance=s.balance)
            for k, s in self._store.items()
        }

    def clear_sessions(self) -> None:
        """Remove all cached session tokens."""
        self._store.clear()

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        """Convenience wrapper around :meth:`request` with ``method="GET"``."""
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        """Convenience wrapper around :meth:`request` with ``method="POST"``."""
        return await self.request("POST", url, **kwargs)

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Send an HTTP request, automatically handling L402 challenges."""
        skey = session_key(url)
        session = self._store.get(skey)

        if session and session.expires_at > time.time():
            headers = dict(kwargs.get("headers", {}))
            headers["X-Session-Token"] = session.token
            kw = {**kwargs, "headers": headers}
            resp = await self._client.request(method, url, **kw)
            if resp.status_code != 402:
                update_session(self._store, skey, resp.headers)
                return resp
            self._store.delete(skey)

        resp = await self._client.request(method, url, **kwargs)

        if resp.status_code != 402:
            return resp

        challenge = parse_challenge(resp.headers.get("www-authenticate"))
        if challenge is None:
            raise L402Error("Failed to parse L402 challenge from 402 response")

        macaroon, invoice = challenge
        amount = self._extract_amount(resp, invoice)

        charge = self._budget_tracker.reserve(amount)
        try:
            preimage = await self._wallet.pay_invoice(invoice)
        except BaseException:
            self._budget_tracker.rollback(charge)
            raise

        headers = dict(kwargs.get("headers", {}))
        headers["Authorization"] = f"L402 {macaroon}:{preimage}"
        kwargs["headers"] = headers

        resp = await self._client.request(method, url, **kwargs)
        update_session(self._store, skey, resp.headers)
        return resp

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncL402Client":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.aclose()

    def _extract_amount(self, resp: httpx.Response, invoice: str) -> int | None:
        try:
            body = resp.json()
        except Exception:
            body = None
        header_amount = (
            resp.headers.get(self._price_header) if self._price_header else None
        )
        return extract_amount(
            body_amount=response_amount_sats(body),
            invoice=invoice,
            header_amount=header_amount,
        )

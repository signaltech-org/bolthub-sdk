"""Async L402 HTTP client, mirroring :class:`bolthub.client.L402Client`."""

from __future__ import annotations

import asyncio
import inspect
import time
from typing import Any, Callable, Optional

import httpx

from ._engine import (
    BudgetTracker,
    L402Error,
    extract_amount,
    parse_challenge,
    response_amount_sats,
    retry_after_seconds,
    session_key,
    update_session,
)
from .awallets import SyncWalletAdapter
from .budget import Budget
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
        budget: Budget | None = None,
        on_paid: Optional[Callable[[dict], None]] = None,
        rate_limit_retries: int = 2,
        max_retry_after: float = 10.0,
    ):
        if budget is not None and budget_sats is not None:
            raise ValueError(
                "AsyncL402Client: pass either an external `budget` or `budget_sats`, not both"
            )
        self._wallet = _ensure_async_wallet(wallet)
        self._budget_tracker = BudgetTracker(
            max_per_request_sats=max_per_request_sats,
            budget_sats=budget_sats,
            on_unknown_amount=on_unknown_amount,
            shared_budget=budget,
        )
        self._price_header = price_header
        self._timeout = timeout
        self._on_paid = on_paid
        self._rate_limit_retries = rate_limit_retries
        self._max_retry_after = max_retry_after
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

    async def request(
        self,
        method: str,
        url: str,
        *,
        max_cost_sats: int | None = None,
        on_paid: Optional[Callable[[dict], None]] = None,
        **kwargs: Any,
    ) -> httpx.Response:
        """Send an HTTP request, automatically handling L402 challenges.

        ``max_cost_sats`` tightens (never loosens) the per-request ceiling for
        this call only. ``on_paid`` fires in addition to the client-level
        callback, letting callers attribute an exact cost to this call.
        """
        skey = session_key(url)
        session = self._store.get(skey)

        if session and session.expires_at > time.time():
            headers = dict(kwargs.get("headers", {}))
            headers["X-Session-Token"] = session.token
            kw = {**kwargs, "headers": headers}
            resp = await self._request_retrying_429(method, url, **kw)
            if resp.status_code != 402:
                update_session(self._store, skey, resp.headers)
                return resp
            self._store.delete(skey)

        resp = await self._request_retrying_429(method, url, **kwargs)

        if resp.status_code != 402:
            return resp

        challenge = parse_challenge(resp.headers.get("www-authenticate"))
        if challenge is None:
            raise L402Error("Failed to parse L402 challenge from 402 response")

        macaroon, invoice = challenge
        amount = self._extract_amount(resp, invoice)

        charge = self._budget_tracker.reserve(amount, max_cost_sats=max_cost_sats)
        try:
            preimage = await self._wallet.pay_invoice(invoice)
        except BaseException:
            self._budget_tracker.rollback(charge)
            raise

        if self._on_paid is not None or on_paid is not None:
            info = {"scheme": "l402", "amount": charge, "asset": "sat", "resource": url}
            if self._on_paid is not None:
                self._on_paid(info)
            if on_paid is not None:
                on_paid(info)

        headers = dict(kwargs.get("headers", {}))
        headers["Authorization"] = f"L402 {macaroon}:{preimage}"
        kwargs["headers"] = headers

        # A 429 here is retried with the SAME L402 proof: the gateway
        # reverts the invoice consumption when it answers 429, so the
        # retry re-uses the payment already made above.
        resp = await self._request_retrying_429(method, url, **kwargs)
        update_session(self._store, skey, resp.headers)
        return resp

    async def _request_retrying_429(
        self, method: str, url: str, **kwargs: Any
    ) -> httpx.Response:
        """One request, waiting out up to ``rate_limit_retries`` 429 answers.

        A 429 whose wait would exceed ``max_retry_after`` — or arriving after
        retries are exhausted — is returned unchanged for the caller.
        """
        resp = await self._client.request(method, url, **kwargs)
        for attempt in range(1, self._rate_limit_retries + 1):
            if resp.status_code != 429:
                break
            wait = retry_after_seconds(resp.headers)
            if wait is None:
                wait = float(2 ** (attempt - 1))
            if wait > self._max_retry_after:
                break
            await asyncio.sleep(wait)
            resp = await self._client.request(method, url, **kwargs)
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

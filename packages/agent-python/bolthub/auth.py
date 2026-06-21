"""``httpx.Auth`` implementation of the L402 payment flow.

``L402Auth`` lets a caller plug L402 payment into *their own* ``httpx`` client
(their pooling, retries, transport — sync or async) instead of using the
SDK-owned :class:`L402Client`::

    auth = L402Auth(wallet, budget_sats=10_000)
    with httpx.Client(auth=auth) as client:
        resp = client.get("https://acme.gw.bolthub.ai/v1/data")

The same instance works for an ``httpx.AsyncClient``. Budget, session, and
unknown-amount semantics match :class:`L402Client`; the shared accounting and
parsing live in :mod:`bolthub._engine`.
"""

from __future__ import annotations

import asyncio
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
from .session_store import InMemorySessionStore, SessionStore

_SESSION_HEADER = "X-Session-Token"


class L402Auth(httpx.Auth):
    """L402 challenge/response auth for any ``httpx`` client.

    Args mirror :class:`L402Client` (minus the owned transport/timeout):

        wallet: Lightning wallet adapter. For the sync flow it must be a sync
            ``WalletAdapter``; for the async flow it may be async or sync (a sync
            wallet is run in a worker thread so it never blocks the event loop).
        max_per_request_sats, budget_sats, on_unknown_amount, price_header:
            see :class:`L402Client`.
        session_store: pluggable session store, shared across requests.

    Thread safety matches :class:`L402Client`: budget accounting is atomic, so a
    single instance may back a client shared across threads or async tasks.
    """

    # NOTE: httpx's ``requires_request_body`` / ``requires_response_body``
    # class flags are intentionally NOT set. They are consulted only by the
    # base ``httpx.Auth.{sync,async}_auth_flow``; we override those methods,
    # so the flags would be dead code. The flows below instead buffer the
    # request body and read the 402 body EXPLICITLY, and crucially never
    # read the post-payment response, so a streaming GET keeps streaming.

    def __init__(
        self,
        wallet: Any,
        *,
        max_per_request_sats: int | None = None,
        budget_sats: int | None = None,
        on_unknown_amount: str = "cap",
        price_header: str | None = None,
        session_store: SessionStore | None = None,
    ) -> None:
        self._wallet = wallet
        self._budget_tracker = BudgetTracker(
            max_per_request_sats=max_per_request_sats,
            budget_sats=budget_sats,
            on_unknown_amount=on_unknown_amount,
        )
        self._price_header = price_header
        self._store: SessionStore = session_store or InMemorySessionStore()

    @property
    def total_spent(self) -> int:
        """Total satoshis spent across all requests."""
        return self._budget_tracker.total_spent

    @property
    def remaining_budget(self) -> int | None:
        """Satoshis remaining, or ``None`` if no budget was set."""
        return self._budget_tracker.remaining_budget

    def clear_sessions(self) -> None:
        """Remove all cached session tokens."""
        self._store.clear()

    # ------------------------------------------------------------------ flows

    def sync_auth_flow(self, request: httpx.Request):
        # Buffer the request body so a POST can be safely re-sent after payment.
        request.read()
        skey = self._attach_session(request)
        response = yield request

        if response.status_code != 402:
            update_session(self._store, skey, response.headers)
            return

        # Read the (small) 402 body so a body-supplied ``amountSats`` is
        # available to _begin_payment. Only this challenge response is read;
        # the post-payment response below is never read here, so a streaming
        # response stays unbuffered.
        response.read()
        macaroon, invoice, charge = self._begin_payment(request, response, skey)
        try:
            preimage = self._wallet.pay_invoice(invoice)
            if inspect.isawaitable(preimage):
                raise L402Error(
                    "sync_auth_flow received an awaitable from the wallet; use an "
                    "async client/wallet or a synchronous WalletAdapter"
                )
        except BaseException:
            self._budget_tracker.rollback(charge)
            raise

        self._apply_preimage(request, macaroon, preimage)
        authed = yield request
        update_session(self._store, skey, authed.headers)

    async def async_auth_flow(self, request: httpx.Request):
        # Buffer the request body so a POST can be safely re-sent after payment.
        await request.aread()
        skey = self._attach_session(request)
        response = yield request

        if response.status_code != 402:
            update_session(self._store, skey, response.headers)
            return

        # Read the (small) 402 body so a body-supplied ``amountSats`` is
        # available to _begin_payment. Only this challenge response is read;
        # the post-payment response below is never read here, so a streaming
        # response stays unbuffered.
        await response.aread()
        macaroon, invoice, charge = self._begin_payment(request, response, skey)
        try:
            preimage = await self._pay_async(invoice)
        except BaseException:
            self._budget_tracker.rollback(charge)
            raise

        self._apply_preimage(request, macaroon, preimage)
        authed = yield request
        update_session(self._store, skey, authed.headers)

    # ---------------------------------------------------------------- helpers

    def _attach_session(self, request: httpx.Request) -> str:
        skey = session_key(str(request.url))
        session = self._store.get(skey)
        if session and session.expires_at > time.time():
            request.headers[_SESSION_HEADER] = session.token
        return skey

    def _begin_payment(
        self, request: httpx.Request, response: httpx.Response, skey: str
    ) -> tuple[str, str, int]:
        # A 402 means any attached session token was rejected; drop it.
        request.headers.pop(_SESSION_HEADER, None)
        self._store.delete(skey)

        challenge = parse_challenge(response.headers.get("www-authenticate"))
        if challenge is None:
            raise L402Error("Failed to parse L402 challenge from 402 response")
        macaroon, invoice = challenge

        amount = self._extract_amount(response, invoice)
        charge = self._budget_tracker.reserve(amount)  # raises L402BudgetError
        return macaroon, invoice, charge

    def _extract_amount(self, response: httpx.Response, invoice: str) -> int | None:
        try:
            body = response.json()
        except Exception:
            body = None
        header_amount = (
            response.headers.get(self._price_header) if self._price_header else None
        )
        return extract_amount(
            body_amount=response_amount_sats(body),
            invoice=invoice,
            header_amount=header_amount,
        )

    @staticmethod
    def _apply_preimage(request: httpx.Request, macaroon: str, preimage: str) -> None:
        request.headers["Authorization"] = f"L402 {macaroon}:{preimage}"
        request.headers.pop(_SESSION_HEADER, None)

    async def _pay_async(self, invoice: str) -> str:
        pay = self._wallet.pay_invoice
        if inspect.iscoroutinefunction(pay):
            return await pay(invoice)
        # Sync wallet: run in a worker thread so it never blocks the event loop.
        return await asyncio.to_thread(pay, invoice)

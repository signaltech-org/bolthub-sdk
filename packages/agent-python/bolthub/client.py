"""L402 HTTP client with automatic payment-challenge handling."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

import httpx

from ._engine import (
    BudgetTracker,
    L402BudgetError,
    L402Error,
    extract_amount,
    parse_challenge,
    response_amount_sats,
    session_key,
    update_session,
)
from .budget import Budget
from .session_store import SessionStore, InMemorySessionStore
from .wallets import WalletAdapter

# Re-exported for backwards compatibility: callers may import these from
# ``bolthub.client`` directly.
__all__ = ["L402Client", "L402Error", "L402BudgetError"]


@dataclass
class _SessionInfo:
    token: str
    expires_at: float
    balance: int | None = None


class L402Client:
    """HTTP client that transparently handles the L402 payment protocol.

    When a server responds with ``402 Payment Required`` and a
    ``WWW-Authenticate: L402`` challenge, the client automatically pays the
    embedded Lightning invoice via the configured wallet adapter, then
    retries the request with proof of payment.

    Thread safety: a single client may be shared across threads. Budget
    accounting is atomic, so ``total_spent`` is always exact and the budget is
    never exceeded, even under concurrent requests. The underlying
    ``httpx.Client`` and the default session store are themselves thread-safe.
    The accounting lock is held only around the budget check, never across the
    network or payment, so concurrent requests still run in parallel; one
    consequence is that several cold-start requests to the same endpoint may
    each pay once before a session token is cached.

    Args:
        wallet: Lightning wallet adapter used to pay invoices.
        max_per_request_sats: Maximum sats allowed for a single invoice.
        budget_sats: Total sats the client may spend before refusing to pay.
        timeout: Timeout in seconds for each HTTP round-trip.
        session_store: Pluggable session store. Defaults to in-memory.
        on_unknown_amount: Policy when an invoice's price cannot be determined
            from the body, the BOLT11 invoice, or ``price_header``. ``"cap"``
            (default) pays only up to ``max_per_request_sats`` (counted against
            the budget) and refuses if no ceiling is set; ``"refuse"`` always
            raises :class:`L402BudgetError`; ``"allow"`` pays blind and counts
            nothing (legacy, unsafe).
        price_header: Optional response header name to read the price (in sats)
            from when the body and invoice do not carry it.
        budget: An external :class:`bolthub.budget.Budget` to draw from instead
            of ``budget_sats``. Share one instance with a
            :class:`bolthub.tool_client.ToolClient` to enforce a single spending
            pool across the HTTP-402 and MCP payment paths. The budget's
            ``max_per_call["sat"]`` also caps each request when
            ``max_per_request_sats`` is unset. Mutually exclusive with
            ``budget_sats``.
        on_paid: Called after each successful invoice payment with
            ``{"scheme", "amount", "asset", "resource"}``.
    """

    def __init__(
        self,
        wallet: WalletAdapter,
        *,
        max_per_request_sats: int | None = None,
        budget_sats: int | None = None,
        timeout: float = 30.0,
        session_store: SessionStore | None = None,
        on_unknown_amount: str = "cap",
        price_header: str | None = None,
        budget: Budget | None = None,
        on_paid: Optional[Callable[[dict], None]] = None,
    ):
        if budget is not None and budget_sats is not None:
            raise ValueError(
                "L402Client: pass either an external `budget` or `budget_sats`, not both"
            )
        self._wallet = wallet
        self._budget_tracker = BudgetTracker(
            max_per_request_sats=max_per_request_sats,
            budget_sats=budget_sats,
            on_unknown_amount=on_unknown_amount,
            shared_budget=budget,
        )
        self._price_header = price_header
        self._timeout = timeout
        self._on_paid = on_paid
        self._client = httpx.Client(timeout=timeout)
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

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        """Convenience wrapper around :meth:`request` with ``method="GET"``."""
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        """Convenience wrapper around :meth:`request` with ``method="POST"``."""
        return self.request("POST", url, **kwargs)

    def request(
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
            resp = self._client.request(method, url, **kw)
            if resp.status_code != 402:
                update_session(self._store, skey, resp.headers)
                return resp
            self._store.delete(skey)

        resp = self._client.request(method, url, **kwargs)

        if resp.status_code != 402:
            return resp

        challenge = parse_challenge(resp.headers.get("www-authenticate"))
        if challenge is None:
            raise L402Error("Failed to parse L402 challenge from 402 response")

        macaroon, invoice = challenge
        amount = self._extract_amount(resp, invoice)

        # Reserve budget *before* paying; roll back if the payment fails so a
        # failed payment is never counted. Raises L402BudgetError on a limit or
        # the unknown-amount policy.
        charge = self._budget_tracker.reserve(amount, max_cost_sats=max_cost_sats)
        try:
            preimage = self._wallet.pay_invoice(invoice)
        except Exception:
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

        resp = self._client.request(method, url, **kwargs)
        update_session(self._store, skey, resp.headers)
        return resp

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> L402Client:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

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

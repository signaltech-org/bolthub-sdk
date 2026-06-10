"""L402 HTTP client with automatic payment-challenge handling."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from .session_store import SessionStore, SessionData, InMemorySessionStore
from .wallets import WalletAdapter


class L402Error(Exception):
    """Base exception for all L402-related failures."""


class L402BudgetError(L402Error):
    """Raised when an invoice exceeds per-request or total budget limits."""


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

    Args:
        wallet: Lightning wallet adapter used to pay invoices.
        max_per_request_sats: Maximum sats allowed for a single invoice.
        budget_sats: Total sats the client may spend before refusing to pay.
        timeout: Timeout in seconds for each HTTP round-trip.
        session_store: Pluggable session store. Defaults to in-memory.
    """

    def __init__(
        self,
        wallet: WalletAdapter,
        *,
        max_per_request_sats: int | None = None,
        budget_sats: int | None = None,
        timeout: float = 30.0,
        session_store: SessionStore | None = None,
    ):
        self._wallet = wallet
        self._max_per_request = max_per_request_sats
        self._budget = budget_sats
        self._spent = 0
        self._timeout = timeout
        self._client = httpx.Client(timeout=timeout)
        self._store: SessionStore = session_store or InMemorySessionStore()

    @property
    def total_spent(self) -> int:
        """Total satoshis spent across all requests since construction."""
        return self._spent

    @property
    def remaining_budget(self) -> int | None:
        """Satoshis remaining, or ``None`` if no budget was set."""
        if self._budget is None:
            return None
        return max(0, self._budget - self._spent)

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

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Send an HTTP request, automatically handling L402 challenges."""
        session_key = self._session_key(url)
        session = self._store.get(session_key)

        if session and session.expires_at > time.time():
            headers = dict(kwargs.get("headers", {}))
            headers["X-Session-Token"] = session.token
            kw = {**kwargs, "headers": headers}
            resp = self._client.request(method, url, **kw)
            if resp.status_code != 402:
                self._update_session(session_key, resp)
                return resp
            self._store.delete(session_key)

        resp = self._client.request(method, url, **kwargs)

        if resp.status_code != 402:
            return resp

        challenge = self._parse_challenge(resp)
        if challenge is None:
            raise L402Error("Failed to parse L402 challenge from 402 response")

        macaroon, invoice = challenge
        amount = self._extract_amount(resp)

        if amount is not None:
            if self._max_per_request is not None and amount > self._max_per_request:
                raise L402BudgetError(
                    f"Invoice amount {amount} sats exceeds per-request limit of {self._max_per_request} sats"
                )
            if self._budget is not None and self._spent + amount > self._budget:
                raise L402BudgetError(
                    f"Invoice amount {amount} sats would exceed total budget "
                    f"(spent: {self._spent}, budget: {self._budget})"
                )

        preimage = self._wallet.pay_invoice(invoice)

        if amount is not None:
            self._spent += amount

        headers = dict(kwargs.get("headers", {}))
        headers["Authorization"] = f"L402 {macaroon}:{preimage}"
        kwargs["headers"] = headers

        resp = self._client.request(method, url, **kwargs)
        self._update_session(session_key, resp)
        return resp

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> L402Client:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    @staticmethod
    def _session_key(url: str) -> str:
        parsed = urlparse(url)
        return f"{parsed.netloc}{parsed.path}"

    def _update_session(self, key: str, resp: httpx.Response) -> None:
        token = resp.headers.get("x-session-token")
        if not token:
            return
        expires_str = resp.headers.get("x-session-expires", "")
        balance_str = resp.headers.get("x-session-balance", "")

        try:
            from datetime import datetime, timezone
            expires_at = datetime.fromisoformat(expires_str.replace("Z", "+00:00")).timestamp()
        except Exception:
            expires_at = time.time() + 3600

        balance: int | None = None
        if balance_str:
            try:
                balance = int(balance_str)
            except ValueError:
                pass

        if balance is not None and balance <= 0:
            self._store.delete(key)
            return

        self._store.set(key, SessionData(token=token, expires_at=expires_at, balance=balance))

    @staticmethod
    def _parse_challenge(resp: httpx.Response) -> tuple[str, str] | None:
        www_auth = resp.headers.get("www-authenticate", "")
        mac_match = re.search(r'macaroon="([^"]+)"', www_auth)
        inv_match = re.search(r'invoice="([^"]+)"', www_auth)
        if not mac_match or not inv_match:
            return None
        return mac_match.group(1), inv_match.group(1)

    @staticmethod
    def _extract_amount(resp: httpx.Response) -> int | None:
        try:
            body = resp.json()
            val = body.get("amountSats")
            if isinstance(val, (int, float)) and val > 0:
                return int(val)
            return None
        except Exception:
            return None

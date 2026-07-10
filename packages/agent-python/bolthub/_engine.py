"""Shared, transport-agnostic core for the L402 flow.

Challenge parsing, price extraction, and budget accounting live here so the
sync client, async client, and :class:`L402Auth` share one implementation
rather than duplicating the logic. Nothing in this module touches the network;
callers pass in already-read response primitives.
"""

from __future__ import annotations

import math
import re
import threading
import time
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any, Mapping
from urllib.parse import urlparse

from ._invoice import bolt11_amount_sats
from .budget import Budget
from .errors import PaymentBudgetError
from .session_store import SessionData, SessionStore


class L402Error(Exception):
    """Base exception for all L402-related failures."""


class L402BudgetError(L402Error):
    """Raised when an invoice exceeds per-request or total budget limits, or
    when its price cannot be determined under a refusing unknown-amount policy.
    """


_MAC_RE = re.compile(r'macaroon="([^"]+)"')
# The token-agnostic field the L402 spec is renaming toward (bLIP-0026).
# Accepted as a fallback; `macaroon=` still wins when both are present, so
# today's gateways parse identically. `\b` avoids matching inside another
# field name (e.g. a stray "mytoken=").
_TOKEN_RE = re.compile(r'\btoken="([^"]+)"')
_INV_RE = re.compile(r'invoice="([^"]+)"')

#: Accepted values for ``on_unknown_amount``.
UNKNOWN_AMOUNT_POLICIES = ("cap", "refuse", "allow")


def parse_challenge(www_authenticate: str | None) -> tuple[str, str] | None:
    """Parse ``(macaroon, invoice)`` from a ``WWW-Authenticate`` header value.

    Returns ``None`` if either field is missing.
    """
    if not www_authenticate:
        return None
    cred = _MAC_RE.search(www_authenticate) or _TOKEN_RE.search(www_authenticate)
    inv = _INV_RE.search(www_authenticate)
    if not cred or not inv:
        return None
    return cred.group(1), inv.group(1)


def response_amount_sats(body: Any) -> Any:
    """Pull ``amountSats`` out of a parsed JSON body, tolerating non-dicts."""
    if isinstance(body, dict):
        return body.get("amountSats")
    return None


def session_key(url: str) -> str:
    """Cache key for a URL: ``<netloc><path>`` (scheme/query ignored)."""
    parsed = urlparse(url)
    return f"{parsed.netloc}{parsed.path}"


def host_key(url: str) -> str:
    """Cache key for prepaid credit: the host only (``<netloc>``). Credit is
    tenant-scoped, so one credential covers all of a provider's endpoints."""
    return urlparse(url).netloc


def retry_after_seconds(headers: Mapping[str, str]) -> float | None:
    """Parse a ``Retry-After`` header (delta-seconds or HTTP-date) into
    seconds to wait, or ``None`` when absent or unparseable."""
    raw = headers.get("retry-after")
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    return max(0.0, parsed.timestamp() - time.time())


def update_session(store: SessionStore, key: str, headers: Mapping[str, str]) -> None:
    """Persist or evict a gateway session based on response headers.

    Reads ``x-session-token`` / ``x-session-expires`` / ``x-session-balance``.
    A non-positive balance evicts the session; a missing token is a no-op.
    """
    token = headers.get("x-session-token")
    if not token:
        return
    expires_str = headers.get("x-session-expires", "") or ""
    balance_str = headers.get("x-session-balance", "") or ""

    try:
        expires_at = datetime.fromisoformat(
            expires_str.replace("Z", "+00:00")
        ).timestamp()
    except Exception:
        expires_at = time.time() + 3600

    balance: int | None = None
    if balance_str:
        try:
            balance = int(balance_str)
        except ValueError:
            pass

    if balance is not None and balance <= 0:
        store.delete(key)
        return

    store.set(key, SessionData(token=token, expires_at=expires_at, balance=balance))


def extract_amount(
    *,
    body_amount: Any = None,
    invoice: str | None = None,
    header_amount: str | None = None,
) -> int | None:
    """Resolve the invoice price in satoshis from the available sources.

    Priority: explicit body ``amountSats`` -> decoded BOLT11 invoice amount ->
    price header. Returns ``None`` when no source yields a positive integer.
    """
    # 1. Body amountSats (the gateway's declared price). bool is an int
    #    subclass, so reject it explicitly.
    if not isinstance(body_amount, bool) and isinstance(body_amount, (int, float)):
        if body_amount > 0:
            return int(body_amount)
    # 2. Decode the BOLT11 invoice (authoritative, always present in a
    #    well-formed L402 challenge).
    if invoice:
        sats = bolt11_amount_sats(invoice)
        if sats is not None and sats > 0:
            return sats
    # 3. Optional price header.
    if header_amount:
        try:
            val = int(str(header_amount).strip())
        except (TypeError, ValueError):
            val = 0
        if val > 0:
            return val
    return None


class BudgetTracker:
    """Per-request and total-budget accounting with an explicit policy for
    invoices whose price cannot be determined.

    Accounting uses a reserve/rollback model: :meth:`reserve` checks the limits
    and provisionally counts the charge *before* payment; the caller invokes
    :meth:`rollback` if the payment ultimately fails, so a failed payment is
    never counted. ``total_spent`` therefore reflects only settled payments.

    Thread-safe: :meth:`reserve` and :meth:`rollback` are guarded by an internal
    lock, so the check-and-count step is atomic. The lock is held only around
    accounting (never across the network/payment), so callers can pay
    concurrently while the budget stays exact and is never exceeded.
    """

    def __init__(
        self,
        *,
        max_per_request_sats: int | None = None,
        budget_sats: int | None = None,
        on_unknown_amount: str = "cap",
        shared_budget: Budget | None = None,
    ) -> None:
        if on_unknown_amount not in UNKNOWN_AMOUNT_POLICIES:
            raise ValueError(
                f"on_unknown_amount must be one of {UNKNOWN_AMOUNT_POLICIES}, "
                f"got {on_unknown_amount!r}"
            )
        if shared_budget is not None and budget_sats is not None:
            raise ValueError(
                "pass either an external shared budget or budget_sats, not both"
            )
        self._max_per_request = max_per_request_sats
        self._budget = budget_sats
        self._on_unknown = on_unknown_amount
        self._shared = shared_budget
        self._spent = 0
        self._lock = threading.Lock()

    @property
    def total_spent(self) -> int:
        """Sats spent so far. With a shared budget this reads the SHARED pool."""
        if self._shared is not None:
            return int(self._shared.spent_for("sat"))
        return self._spent

    @property
    def remaining_budget(self) -> int | None:
        if self._shared is not None:
            remaining = self._shared.remaining_for("sat")
            return None if math.isinf(remaining) else int(remaining)
        if self._budget is None:
            return None
        return max(0, self._budget - self._spent)

    def _effective_cap(self, max_cost_sats: int | None) -> int | None:
        """The per-request ceiling for one call: ``max_per_request_sats``,
        tightened by the shared budget's ``max_per_call["sat"]`` and by the
        caller's one-off ``max_cost_sats``. ``None`` = uncapped.
        """
        cap = math.inf if self._max_per_request is None else self._max_per_request
        if self._shared is not None:
            cap = min(cap, self._shared.per_call_for("sat"))
        if max_cost_sats is not None:
            cap = min(cap, max_cost_sats)
        return None if math.isinf(cap) else int(cap)

    def reserve(self, amount: int | None, *, max_cost_sats: int | None = None) -> int:
        """Validate and provisionally count an invoice's charge.

        ``amount`` is the resolved price in sats, or ``None`` if it could not be
        determined. ``max_cost_sats`` tightens the per-request ceiling for this
        one call. Returns the number of sats reserved (to pass back to
        :meth:`rollback` on payment failure). Raises :class:`L402BudgetError`
        when a limit would be exceeded or the unknown-amount policy refuses.

        The check and the reservation happen atomically (under this tracker's
        lock, or the shared :class:`Budget`'s), so concurrent callers can never
        both pass a budget check and then overspend.
        """
        cap = self._effective_cap(max_cost_sats)
        if self._shared is not None:
            charge = self._resolve_charge(amount, cap)
            if charge > 0:
                try:
                    self._shared.reserve("sat", charge)
                except PaymentBudgetError as exc:
                    raise L402BudgetError(str(exc)) from exc
            return charge
        with self._lock:
            charge = self._resolve_charge(amount, cap)
            self._spent += charge
            return charge

    def rollback(self, charge: int) -> None:
        """Undo a prior :meth:`reserve` (e.g. when payment fails)."""
        if not charge:
            return
        if self._shared is not None:
            self._shared.rollback("sat", charge)
            return
        with self._lock:
            self._spent -= charge

    def _resolve_charge(self, amount: int | None, cap: int | None) -> int:
        if amount is None:
            return self._resolve_unknown(cap)
        if cap is not None and amount > cap:
            raise L402BudgetError(
                f"Invoice amount {amount} sats exceeds per-request limit of "
                f"{cap} sats"
            )
        self._check_budget(amount)
        return amount

    def _resolve_unknown(self, cap: int | None) -> int:
        if self._on_unknown == "allow":
            return 0
        if self._on_unknown == "refuse":
            raise L402BudgetError(
                "Invoice amount could not be determined; refusing to pay "
                "(on_unknown_amount='refuse')"
            )
        # "cap": pay only up to the per-request ceiling (counted against the
        # budget); refuse outright when no ceiling is configured.
        if cap is None:
            raise L402BudgetError(
                "Invoice amount could not be determined and no "
                "max_per_request_sats is set; refusing to pay"
            )
        self._check_budget(cap)
        return cap

    def _check_budget(self, charge: int) -> None:
        if self._shared is not None:
            denial = self._shared.check("sat", charge)
            if denial:
                raise L402BudgetError(
                    f"Invoice amount {charge} sats {denial} "
                    f"(spent: {int(self._shared.spent_for('sat'))}, "
                    f"remaining: {self._shared.remaining_for('sat')})"
                )
            return
        if self._budget is not None and self._spent + charge > self._budget:
            raise L402BudgetError(
                f"Invoice amount {charge} sats would exceed total budget "
                f"(spent: {self._spent}, budget: {self._budget})"
            )

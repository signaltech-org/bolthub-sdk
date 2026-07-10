"""L402 HTTP client with automatic payment-challenge handling."""

from __future__ import annotations

import random
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import httpx

from ._engine import (
    BudgetTracker,
    L402BudgetError,
    L402Error,
    extract_amount,
    host_key,
    parse_challenge,
    response_amount_sats,
    retry_after_seconds,
    session_key,
    update_session,
)
from .budget import Budget
from .payment_status import UpstreamFailedError, read_payment_status
from .receipt_store import Receipt, ReceiptStore, export_receipts
from .session_store import SessionStore, InMemorySessionStore
from .wallets import WalletAdapter

# Re-exported for backwards compatibility: callers may import these from
# ``bolthub.client`` directly.
__all__ = ["L402Client", "L402Error", "L402BudgetError"]

# Prepaid credit is tenant-scoped, cached per HOST (not host+path). The gateway's
# 402 (credit spent/expired) is the authoritative invalidation; this 30-day floor
# just stops a definitely-dead credential being re-sent forever.
_CREDIT_CREDENTIAL_TTL = 30 * 24 * 60 * 60


@dataclass
class _SessionInfo:
    token: str
    expires_at: float
    balance: int | None = None


def _response_payment_hash(resp: httpx.Response) -> str | None:
    """Payment hash from a 402 body (``paymentHash``, present on bolthub
    gateways). Optional receipt metadata: derive sha256(preimage) when absent."""
    try:
        body = resp.json()
    except Exception:
        return None
    value = body.get("paymentHash") if isinstance(body, dict) else None
    return value if isinstance(value, str) and value else None


def _record_receipt(
    store: ReceiptStore | None,
    *,
    method: str,
    url: str,
    charge: int,
    preimage: str,
    invoice: str,
    payment_hash: str | None,
    resp: httpx.Response,
) -> None:
    """Record one receipt per settled payment (opt-in: no store, no write).

    ``outcome`` is the gateway's ``X-Bolthub-Payment`` header when emitted;
    the store fills ``payment_hash`` from the preimage when the 402 body
    lacked it. A store failure is surfaced as a warning, never as a failed
    request: the paid call already succeeded.
    """
    if store is None:
        return
    try:
        store.append(
            Receipt(
                receipt_v=1,
                ts=datetime.now(timezone.utc).isoformat(),
                resource=url,
                method=method.upper(),
                amount_sats=charge,
                payment_hash=payment_hash or "",
                preimage=preimage,
                invoice=invoice,
                outcome=resp.headers.get("X-Bolthub-Payment", "unknown"),
            )
        )
    except Exception as exc:  # noqa: BLE001 - receipt loss must not fail the call
        print(f"bolthub: failed to record payment receipt: {exc}", file=sys.stderr)


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
        rate_limit_retries: Automatic retries when the server answers
            ``429 Too Many Requests``, on every leg of the flow. Waits out
            the response's ``Retry-After`` (delta-seconds or HTTP-date; 1s,
            2s, … backoff when absent) and re-sends the same request. On the
            post-payment leg this re-presents the same ``macaroon:preimage``
            — bolthub gateways revert the invoice consumption when they
            answer 429, so the retry re-uses the payment rather than paying
            twice. Defaults to 2; 0 disables.
        max_retry_after: Longest single ``Retry-After`` wait honored, in
            seconds; a 429 demanding more is returned immediately.
            Defaults to 10.
        retry_on_upstream_failure: Automatic free retries when the gateway
            reports an upstream failure it already un-charged
            (``X-Bolthub-Payment-Code: upstream_failed_retryable`` — the
            preimage redeems again / the deduction went back to the session
            balance). Strictly signal-gated: a bare 5xx without the header
            is returned untouched. Defaults to True.
        upstream_retries: How many free retries to attempt on
            ``upstream_failed_retryable`` responses, with jittered
            exponential backoff (0.25s, 0.5s, …). Defaults to 2; 0 disables.
        throw_on_upstream_failure: When True, an ``upstream_failed_retryable``
            response that survives all retries raises
            :class:`bolthub.payment_status.UpstreamFailedError` instead of
            returning the failed response. Defaults to False to preserve the
            return-the-response contract.
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
        rate_limit_retries: int = 2,
        max_retry_after: float = 10.0,
        retry_on_upstream_failure: bool = True,
        upstream_retries: int = 2,
        throw_on_upstream_failure: bool = False,
        receipt_store: ReceiptStore | None = None,
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
        self._rate_limit_retries = rate_limit_retries
        self._max_retry_after = max_retry_after
        self._retry_on_upstream_failure = retry_on_upstream_failure
        self._upstream_retries = upstream_retries
        self._throw_on_upstream_failure = throw_on_upstream_failure
        self._receipt_store = receipt_store
        self._client = httpx.Client(timeout=timeout)
        self._store: SessionStore = session_store or InMemorySessionStore()
        # Prepaid-credit credentials by HOST: (macaroon, preimage, expires_at).
        self._credit_store: dict[str, tuple[str, str, float]] = {}

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

    def export_receipts(
        self,
        *,
        from_ts=None,
        to_ts=None,
        format: str = "json",
        redact: bool = False,
    ) -> str:
        """Serialize this client's payment receipts (requires a configured
        ``receipt_store``). JSON by default, ``csv`` per the schema column
        order; ``redact=True`` strips preimages for shareable reports."""
        if self._receipt_store is None:
            raise L402Error(
                "export_receipts: no receipt_store configured — pass one "
                "(e.g. FileReceiptStore()) to the client constructor"
            )
        receipts = self._receipt_store.list(from_ts=from_ts, to_ts=to_ts)
        return export_receipts(receipts, format=format, redact=redact)

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        """Convenience wrapper around :meth:`request` with ``method="GET"``."""
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        """Convenience wrapper around :meth:`request` with ``method="POST"``."""
        return self.request("POST", url, **kwargs)

    def buy_bundle(self, *args: Any, **kwargs: Any) -> dict:
        """Retired. Prepaid bundles have been removed; pay per call, or use
        prepaid credit for cross-endpoint prepayment when it lands. This method
        now raises and pays nothing."""
        raise L402Error(
            "buy_bundle is retired: pay per call, or use prepaid credit for "
            "cross-endpoint prepayment. See https://docs.bolthub.ai/docs/sdks/python"
        )

    def clear_credits(self) -> None:
        """Drop all cached prepaid-credit credentials."""
        self._credit_store.clear()

    def buy_credit(
        self,
        url: str,
        credit_sats: int,
        *,
        method: str = "GET",
        max_cost_sats: int | None = None,
        on_paid: Optional[Callable[[dict], None]] = None,
        **kwargs: Any,
    ) -> dict:
        """Buy prepaid credit for a provider: pay once for ``credit_sats`` of
        credit (face-value — the server charges exactly that, no discount
        tiers), then :meth:`request` calls to ANY of that provider's endpoints
        draw the budget instead of paying, until spent. Credit is tenant-scoped,
        cached and reused per host. Sends ``X-Bolthub-Credit: <credit_sats>``,
        verifies the server honored the exact budget, then pays (``budget_sats``
        + ``max_cost_sats`` enforced). Raises :class:`L402Error` if the provider
        did not answer with a credit challenge, or did not echo the requested
        budget — nothing is paid in either case."""
        if not isinstance(credit_sats, int) or credit_sats <= 0:
            raise L402Error("buy_credit: credit_sats must be a positive integer")

        headers = dict(kwargs.get("headers", {}))
        headers["X-Bolthub-Credit"] = str(credit_sats)
        kw = {**kwargs, "headers": headers}

        resp = self._request_retrying_429(method, url, **kw)
        if resp.status_code != 402:
            detail = ""
            try:
                detail = (resp.json() or {}).get("error", "")
            except Exception:
                pass
            raise L402Error(
                f"buy_credit: provider did not offer prepaid credit (HTTP {resp.status_code}"
                + (f": {detail}" if detail else "")
                + ")"
            )

        # SECURITY: the server is the authority on the honored budget. An honored
        # credit challenge echoes ``creditSats`` (== the requested face-value
        # budget) in the 402 body. No echo (or a different value) means the server
        # did not open credit for this amount — paying it and caching it as credit
        # would be a phantom purchase. Refuse BEFORE the wallet is touched.
        echoed: int | None = None
        try:
            body = resp.json()
        except Exception:
            body = None
        if isinstance(body, dict):
            val = body.get("creditSats")
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                echoed = int(val)
        if echoed != credit_sats:
            if echoed is None:
                raise L402Error(
                    "buy_credit: the server did not honor the credit request (no "
                    "creditSats in the challenge) — prepaid credit may not be enabled "
                    "for this provider; nothing was paid"
                )
            raise L402Error(
                f"buy_credit: the server honored {echoed} sats of credit, not the "
                f"{credit_sats} requested; nothing was paid"
            )

        challenge = parse_challenge(resp.headers.get("www-authenticate"))
        if challenge is None:
            raise L402Error("buy_credit: failed to parse the credit challenge")
        macaroon, invoice = challenge

        amount = self._extract_amount(resp, invoice)
        charge = self._budget_tracker.reserve(amount, max_cost_sats=max_cost_sats)
        try:
            preimage = self._wallet.pay_invoice(invoice)
        except Exception:
            self._budget_tracker.rollback(charge)
            raise

        self._credit_store[host_key(url)] = (
            macaroon,
            preimage,
            time.time() + _CREDIT_CREDENTIAL_TTL,
        )

        payment_hash = _response_payment_hash(resp)
        if self._on_paid is not None or on_paid is not None:
            info = {
                "scheme": "l402",
                "amount": charge,
                "asset": "sat",
                "resource": url,
                "preimage": preimage,
                "invoice": invoice,
                "payment_hash": payment_hash,
            }
            if self._on_paid is not None:
                self._on_paid(info)
            if on_paid is not None:
                on_paid(info)
        _record_receipt(
            self._receipt_store,
            method=method,
            url=url,
            charge=charge,
            preimage=preimage,
            invoice=invoice,
            payment_hash=payment_hash,
            resp=resp,
        )
        return {"credit_sats": credit_sats, "host": host_key(url)}

    def batch_fetch(
        self,
        urls: list[str],
        *,
        credit_sats: int,
        method: str = "GET",
        **kwargs: Any,
    ) -> list[httpx.Response]:
        """Fetch several URLs, collapsing the Lightning payments to ONE per
        provider. Groups by host; for each host without cached credit, buys
        ``credit_sats`` once, then fetches each URL (drawing that credit).
        Non-custodial: N providers means N payments, never a pooled balance.
        Size ``credit_sats`` to cover the calls you expect to make per provider;
        unused credit at expiry is non-refundable."""
        hosts = list(dict.fromkeys(host_key(u) for u in urls))
        for h in hosts:
            held = self._credit_store.get(h)
            if held is None or held[2] <= time.time():
                seed = next(u for u in urls if host_key(u) == h)
                self.buy_credit(seed, credit_sats, method=method, **kwargs)
        return [self.request(method, u, **kwargs) for u in urls]

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

        # Prepaid credit: present a cached credential for this host first (draws
        # the prepaid budget, no payment) on ANY of the provider's endpoints. A
        # 402 means the credit is spent — drop it and fall through to the normal
        # session / single-use flow.
        hkey = host_key(url)
        credit = self._credit_store.get(hkey)
        if credit is not None:
            macaroon_c, preimage_c, expires_c = credit
            if expires_c > time.time():
                headers = dict(kwargs.get("headers", {}))
                headers["Authorization"] = f"L402 {macaroon_c}:{preimage_c}"
                kw = {**kwargs, "headers": headers}
                resp = self._request_retrying_upstream(method, url, **kw)
                if resp.status_code != 402:
                    return resp
                del self._credit_store[hkey]
            else:
                del self._credit_store[hkey]

        session = self._store.get(skey)

        if session and session.expires_at > time.time():
            headers = dict(kwargs.get("headers", {}))
            headers["X-Session-Token"] = session.token
            kw = {**kwargs, "headers": headers}
            resp = self._request_retrying_upstream(method, url, **kw)
            if resp.status_code != 402:
                update_session(self._store, skey, resp.headers)
                return resp
            self._store.delete(skey)

        resp = self._request_retrying_429(method, url, **kwargs)

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

        payment_hash = _response_payment_hash(resp)
        if self._on_paid is not None or on_paid is not None:
            # preimage/invoice/payment_hash are the receipt fields (additive
            # as of 0.4.x): together they prove the payment offline. The hash
            # comes from the 402 body when present; sha256(preimage) equals it.
            info = {
                "scheme": "l402",
                "amount": charge,
                "asset": "sat",
                "resource": url,
                "preimage": preimage,
                "invoice": invoice,
                "payment_hash": payment_hash,
            }
            if self._on_paid is not None:
                self._on_paid(info)
            if on_paid is not None:
                on_paid(info)

        headers = dict(kwargs.get("headers", {}))
        headers["Authorization"] = f"L402 {macaroon}:{preimage}"
        kwargs["headers"] = headers

        # A 429 here is retried with the SAME L402 proof: the gateway
        # reverts the invoice consumption when it answers 429, so the
        # retry re-uses the payment already made above. The same holds for
        # origin failures the gateway reports as upstream_failed_retryable.
        resp = self._request_retrying_upstream(method, url, **kwargs)
        update_session(self._store, skey, resp.headers)
        _record_receipt(
            self._receipt_store,
            method=method,
            url=url,
            charge=charge,
            preimage=preimage,
            invoice=invoice,
            payment_hash=payment_hash,
            resp=resp,
        )
        return resp

    def _request_retrying_upstream(
        self, method: str, url: str, **kwargs: Any
    ) -> httpx.Response:
        """Credentialed request (429-aware), then wait out gateway-signaled
        upstream failures.

        When the response carries ``X-Bolthub-Payment-Code:
        upstream_failed_retryable`` the payment layer already un-charged the
        request — the held credential re-redeems for free — so the identical
        request is re-sent with jittered backoff (0.25s, 0.5s, …), up to
        ``upstream_retries`` times. Strictly signal-gated: a bare 5xx
        without the header is returned untouched.
        """
        resp = self._request_retrying_429(method, url, **kwargs)
        attempts = 1
        if self._retry_on_upstream_failure and self._upstream_retries > 0:
            for attempt in range(1, self._upstream_retries + 1):
                status = read_payment_status(resp.headers)
                if status is None or status.code != "upstream_failed_retryable":
                    break
                time.sleep(0.25 * 2 ** (attempt - 1) + random.random() * 0.1)
                resp = self._request_retrying_429(method, url, **kwargs)
                attempts += 1
        if self._throw_on_upstream_failure:
            status = read_payment_status(resp.headers)
            if status is not None and status.code == "upstream_failed_retryable":
                raise UpstreamFailedError(
                    f"Upstream failed (HTTP {resp.status_code}) after {attempts} "
                    f"attempt(s); payment {status.state} — retrying later is free",
                    payment_status=status,
                    http_status=resp.status_code,
                    attempts=attempts,
                    resource=url,
                )
        return resp

    def _request_retrying_429(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """One request, waiting out up to ``rate_limit_retries`` 429 answers.

        A 429 whose wait would exceed ``max_retry_after`` — or arriving after
        retries are exhausted — is returned unchanged for the caller.
        """
        resp = self._client.request(method, url, **kwargs)
        for attempt in range(1, self._rate_limit_retries + 1):
            if resp.status_code != 429:
                break
            wait = retry_after_seconds(resp.headers)
            if wait is None:
                wait = float(2 ** (attempt - 1))
            if wait > self._max_retry_after:
                break
            time.sleep(wait)
            resp = self._client.request(method, url, **kwargs)
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

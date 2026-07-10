"""Upstream-failure free retry — parity with @bolthub/pay's http-upstream-retry tests.

Pins: retries fire ONLY on the gateway's explicit
``X-Bolthub-Payment-Code: upstream_failed_retryable`` signal (bare 5xx is
returned untouched); a successful retry costs zero extra payments; exhausted
retries return the final response by default; ``throw_on_upstream_failure``
raises a typed :class:`UpstreamFailedError` carrying the parsed status.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import pytest

from bolthub import (
    AsyncL402Client,
    L402Client,
    PaymentStatus,
    UpstreamFailedError,
    read_payment_status,
)
from bolthub.payment_status import PAYMENT_CODE_HEADER, PAYMENT_HEADER


class MockWallet:
    def __init__(self, preimage="abc123"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


def scripted(responses, calls):
    def side_effect(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        return responses[len(calls) - 1]

    return side_effect


def make_402(amount_sats=100):
    return httpx.Response(
        status_code=402,
        headers={"WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."'},
        json={"error": "Payment Required", "amountSats": amount_sats},
    )


def make_reverted_failure(status=502, extra_headers=None):
    headers = {
        PAYMENT_HEADER: "reverted",
        PAYMENT_CODE_HEADER: "upstream_failed_retryable",
        **(extra_headers or {}),
    }
    return httpx.Response(
        status_code=status, headers=headers, json={"error": "Origin connection failed"}
    )


def make_200(headers=None):
    return httpx.Response(status_code=200, headers=headers or {}, json={"ok": True})


class TestReadPaymentStatus:
    def test_none_without_header(self):
        assert read_payment_status(httpx.Headers()) is None

    def test_parses_state_and_code(self):
        headers = httpx.Headers(
            {
                PAYMENT_HEADER: "refunded_to_balance",
                PAYMENT_CODE_HEADER: "upstream_failed_retryable",
            }
        )
        assert read_payment_status(headers) == PaymentStatus(
            state="refunded_to_balance", code="upstream_failed_retryable"
        )

    def test_state_without_code(self):
        headers = httpx.Headers({PAYMENT_HEADER: "charged"})
        assert read_payment_status(headers) == PaymentStatus(state="charged", code=None)


class TestSyncUpstreamRetry:
    def test_free_retry_succeeds_single_payment(self):
        wallet = MockWallet("preimage123")
        client = L402Client(wallet)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402(), make_reverted_failure(), make_200()], calls),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1000..."]  # retry was free
        assert len(calls) == 3
        # Both post-payment attempts re-present the same proof.
        assert calls[1]["headers"]["Authorization"] == "L402 mac123:preimage123"
        assert calls[2]["headers"]["Authorization"] == "L402 mac123:preimage123"

    def test_bare_5xx_without_header_untouched(self):
        client = L402Client(MockWallet())
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted(
                [make_402(), httpx.Response(status_code=502, text="boom")], calls
            ),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 502
        assert len(calls) == 2  # no blind retries

    def test_exhausted_retries_return_final_response(self):
        wallet = MockWallet()
        client = L402Client(wallet, upstream_retries=2)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted(
                [make_402()] + [make_reverted_failure()] * 3, calls
            ),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 502
        assert read_payment_status(resp.headers).state == "reverted"
        assert len(calls) == 4  # challenge + initial + 2 retries
        assert wallet.calls == ["lnbc1000..."]

    def test_opt_out_returns_first_failure(self):
        client = L402Client(MockWallet(), retry_on_upstream_failure=False)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402(), make_reverted_failure()], calls),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 502
        assert len(calls) == 2

    def test_throw_on_upstream_failure_raises_typed_error(self):
        client = L402Client(
            MockWallet(), upstream_retries=1, throw_on_upstream_failure=True
        )
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402()] + [make_reverted_failure()] * 2, calls),
        ):
            with pytest.raises(UpstreamFailedError) as exc:
                client.get("https://example.com/api")
        err = exc.value
        assert err.retryable is True
        assert err.http_status == 502
        assert err.attempts == 2
        assert err.payment_status.state == "reverted"
        assert err.payment_status.code == "upstream_failed_retryable"
        assert err.resource == "https://example.com/api"

    def test_session_leg_retries_on_refunded_to_balance(self):
        wallet = MockWallet()
        client = L402Client(wallet)
        session_headers = {
            "X-Session-Token": "sess-1",
            "X-Session-Expires": (
                datetime.now(timezone.utc) + timedelta(hours=1)
            ).isoformat(),
            "X-Session-Balance": "90",
        }
        seed_calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402(), make_200(headers=session_headers)], seed_calls),
        ):
            client.get("https://example.com/api")
        assert wallet.calls == ["lnbc1000..."]

        refunded = make_reverted_failure(
            status=500,
            extra_headers={"X-Session-Token": "sess-1", "X-Session-Balance": "90"},
        )
        # Overwrite state header for the session model.
        refunded.headers[PAYMENT_HEADER] = "refunded_to_balance"
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted(
                [
                    refunded,
                    make_200(
                        headers={"X-Session-Token": "sess-1", "X-Session-Balance": "80"}
                    ),
                ],
                calls,
            ),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1000..."]  # still one payment total
        assert len(calls) == 2

    def test_charged_upstream_rejected_never_retried(self):
        client = L402Client(MockWallet())
        calls = []
        rejected = httpx.Response(
            status_code=400,
            headers={PAYMENT_HEADER: "charged", PAYMENT_CODE_HEADER: "upstream_rejected"},
            json={"error": "bad request"},
        )
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402(), rejected], calls),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 400
        assert len(calls) == 2


class TestAsyncUpstreamRetry:
    def test_free_retry_succeeds_single_payment(self):
        async def run():
            wallet = MockWallet("preimage123")
            client = AsyncL402Client(wallet)
            calls = []

            responses = [make_402(), make_reverted_failure(), make_200()]

            async def side_effect(method, url, **kwargs):
                calls.append({"method": method, "url": url, **kwargs})
                return responses[len(calls) - 1]

            with patch.object(client._client, "request", side_effect=side_effect):
                resp = await client.request("GET", "https://example.com/api")
            assert resp.status_code == 200
            assert wallet.calls == ["lnbc1000..."]
            assert len(calls) == 3

        asyncio.run(run())

    def test_throw_raises_typed_error(self):
        async def run():
            client = AsyncL402Client(
                MockWallet(), upstream_retries=1, throw_on_upstream_failure=True
            )
            calls = []
            responses = [make_402()] + [make_reverted_failure()] * 2

            async def side_effect(method, url, **kwargs):
                calls.append(1)
                return responses[len(calls) - 1]

            with patch.object(client._client, "request", side_effect=side_effect):
                with pytest.raises(UpstreamFailedError) as exc:
                    await client.request("GET", "https://example.com/api")
            assert exc.value.attempts == 2
            assert exc.value.payment_status.code == "upstream_failed_retryable"

        asyncio.run(run())

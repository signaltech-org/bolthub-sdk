"""429/Retry-After handling — parity with @bolthub/pay's http-client-429 tests.

Pins: every leg (challenge, session reuse, post-payment retry) waits out
Retry-After and re-sends; the post-payment retry re-presents the SAME
macaroon:preimage (gateways revert consumption on 429, so this re-uses the
payment); waits beyond max_retry_after and exhausted retries surface the
429 unchanged.
"""

import asyncio
from email.utils import format_datetime
from datetime import datetime, timedelta, timezone

import httpx
from unittest.mock import patch

from bolthub import L402Client, AsyncL402Client


class MockWallet:
    def __init__(self, preimage="abc123"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


def make_429(retry_after="0"):
    headers = {"Retry-After": retry_after} if retry_after is not None else {}
    return httpx.Response(status_code=429, headers=headers, json={"error": "Too many requests"})


def make_402(amount_sats=100):
    return httpx.Response(
        status_code=402,
        headers={"WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."'},
        json={"error": "Payment Required", "amountSats": amount_sats},
    )


def make_200(headers=None):
    return httpx.Response(status_code=200, headers=headers or {}, json={"ok": True})


def scripted(responses, calls):
    """side_effect that pops canned responses and records each call's kwargs."""

    def side_effect(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        return responses[len(calls) - 1]

    return side_effect


class TestSync429:
    def test_challenge_leg_waits_out_retry_after(self):
        client = L402Client(MockWallet())
        calls = []
        with patch.object(
            client._client, "request", side_effect=scripted([make_429(), make_200()], calls)
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert len(calls) == 2

    def test_post_payment_leg_retries_with_same_proof_pays_once(self):
        wallet = MockWallet("preimage123")
        client = L402Client(wallet)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402(), make_429(), make_200()], calls),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1000..."]
        assert calls[1]["headers"]["Authorization"] == "L402 mac123:preimage123"
        assert calls[2]["headers"]["Authorization"] == "L402 mac123:preimage123"

    def test_session_reuse_leg_retries_without_dropping_session(self):
        client = L402Client(MockWallet())
        session_headers = {
            "X-Session-Token": "sess_1",
            "X-Session-Expires": (
                datetime.now(timezone.utc) + timedelta(hours=1)
            ).isoformat(),
        }
        seed_calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402(), make_200(headers=session_headers)], seed_calls),
        ):
            client.get("https://example.com/api")

        calls = []
        with patch.object(
            client._client, "request", side_effect=scripted([make_429(), make_200()], calls)
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert len(calls) == 2
        assert calls[0]["headers"]["X-Session-Token"] == "sess_1"
        assert calls[1]["headers"]["X-Session-Token"] == "sess_1"

    def test_retry_after_beyond_cap_surfaces_429(self):
        client = L402Client(MockWallet(), max_retry_after=5.0)
        calls = []
        with patch.object(
            client._client, "request", side_effect=scripted([make_429("3600")], calls)
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 429
        assert len(calls) == 1

    def test_retries_are_bounded(self):
        client = L402Client(MockWallet(), rate_limit_retries=2)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_429(), make_429(), make_429(), make_429()], calls),
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 429
        assert len(calls) == 3  # initial + 2 retries

    def test_zero_retries_disables(self):
        client = L402Client(MockWallet(), rate_limit_retries=0)
        calls = []
        with patch.object(
            client._client, "request", side_effect=scripted([make_429()], calls)
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 429
        assert len(calls) == 1

    def test_http_date_retry_after_is_honored(self):
        client = L402Client(MockWallet())
        past = format_datetime(datetime.now(timezone.utc) - timedelta(seconds=1))
        calls = []
        with patch.object(
            client._client, "request", side_effect=scripted([make_429(past), make_200()], calls)
        ):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert len(calls) == 2


def async_scripted(responses, calls):
    async def side_effect(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        return responses[len(calls) - 1]

    return side_effect


class TestAsync429:
    def test_challenge_leg_waits_out_retry_after(self):
        async def go():
            client = AsyncL402Client(MockWallet())
            calls = []
            with patch.object(
                client._client,
                "request",
                side_effect=async_scripted([make_429(), make_200()], calls),
            ):
                resp = await client.get("https://example.com/api")
            await client.aclose()
            return resp, calls

        resp, calls = asyncio.run(go())
        assert resp.status_code == 200
        assert len(calls) == 2

    def test_post_payment_leg_retries_with_same_proof_pays_once(self):
        wallet = MockWallet("preimage123")

        async def go():
            client = AsyncL402Client(wallet)
            calls = []
            with patch.object(
                client._client,
                "request",
                side_effect=async_scripted([make_402(), make_429(), make_200()], calls),
            ):
                resp = await client.get("https://example.com/api")
            await client.aclose()
            return resp, calls

        resp, calls = asyncio.run(go())
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1000..."]
        assert calls[1]["headers"]["Authorization"] == "L402 mac123:preimage123"
        assert calls[2]["headers"]["Authorization"] == "L402 mac123:preimage123"

    def test_retries_are_bounded(self):
        async def go():
            client = AsyncL402Client(MockWallet(), rate_limit_retries=1)
            calls = []
            with patch.object(
                client._client,
                "request",
                side_effect=async_scripted([make_429(), make_429()], calls),
            ):
                resp = await client.get("https://example.com/api")
            await client.aclose()
            return resp, calls

        resp, calls = asyncio.run(go())
        assert resp.status_code == 429
        assert len(calls) == 2

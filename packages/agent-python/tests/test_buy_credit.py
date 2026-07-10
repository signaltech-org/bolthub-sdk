"""buy_credit + cross-endpoint reuse (cross-endpoint prepaid credit) — parity
with @bolthub/pay. Pay once per PROVIDER (host), then request() to ANY of that
provider's endpoints draws the credit until spent. Credit is FACE-VALUE: the
client passes a sats budget and the server charges exactly that (no tiers).
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import httpx
import pytest

from bolthub import AsyncL402Client, L402BudgetError, L402Client, L402Error


class MockWallet:
    def __init__(self, preimage="beef"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


def scripted(responses, calls):
    def side_effect(method, url, **kwargs):
        h = dict(kwargs.get("headers", {}))
        calls.append({"url": url, "auth": h.get("Authorization"), "credit": h.get("X-Bolthub-Credit")})
        return responses[len(calls) - 1]

    return side_effect


def credit_challenge(credit_sats: int = 10000):
    """An HONORED credit challenge echoes ``creditSats`` (== the requested budget)."""
    return httpx.Response(
        status_code=402,
        headers={"WWW-Authenticate": 'L402 macaroon="creditmac", invoice="lnbc10000..."'},
        json={"error": "Payment Required", "amountSats": credit_sats, "paymentHash": "h1", "creditSats": credit_sats},
    )


class TestBuyCreditSync:
    def test_pays_once_then_reuses_across_endpoints(self):
        wallet = MockWallet("beef")
        client = L402Client(wallet)
        calls = []
        responses = [
            credit_challenge(),  # buy
            httpx.Response(status_code=200, json={"a": 1}),  # /v1/a
            httpx.Response(status_code=200, json={"b": 2}),  # /v1/b (same host)
        ]
        with patch.object(client._client, "request", side_effect=scripted(responses, calls)):
            bought = client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
            assert bought == {"credit_sats": 10000, "host": "acme.gw.bolthub.ai"}
            assert calls[0]["credit"] == "10000"
            r1 = client.get("https://acme.gw.bolthub.ai/v1/a")
            r2 = client.get("https://acme.gw.bolthub.ai/v1/b")
        assert r1.status_code == 200 and r2.status_code == 200
        assert wallet.calls == ["lnbc10000..."]  # ONE payment for two endpoints
        assert calls[1]["auth"] == "L402 creditmac:beef"
        assert calls[2]["auth"] == "L402 creditmac:beef"

    def test_credit_does_not_leak_across_hosts(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=10000)  # covers one purchase only
        with patch.object(
            client._client, "request",
            side_effect=scripted([credit_challenge()], []),
        ):
            client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
        # Other provider has no credit → normal flow → 402 → no budget → raises.
        other = httpx.Response(
            status_code=402,
            headers={"WWW-Authenticate": 'L402 macaroon="x", invoice="lnbc1..."'},
            text="pay",
        )
        with patch.object(client._client, "request", side_effect=scripted([other], [])):
            with pytest.raises(L402BudgetError):
                client.get("https://other.gw.bolthub.ai/v1/data")

    def test_security_refuses_when_no_credit_echo(self):
        # SECURITY: honored-looking 402 (has an invoice) but NO creditSats echo —
        # the server minted a plain single-use invoice, not a credit budget.
        # buy_credit must refuse and pay nothing.
        wallet = MockWallet()
        client = L402Client(wallet)
        no_echo = httpx.Response(
            status_code=402,
            headers={"WWW-Authenticate": 'L402 macaroon="notcredit", invoice="lnbc10000..."'},
            json={"error": "Payment Required", "amountSats": 10000, "paymentHash": "h1"},
        )
        calls = []
        with patch.object(client._client, "request", side_effect=scripted([no_echo], calls)):
            with pytest.raises(L402Error, match="did not honor the credit request"):
                client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
        assert wallet.calls == []  # nothing paid
        assert len(calls) == 1  # only the challenge fetch; no retry/pay

    def test_security_refuses_on_credit_mismatch(self):
        # SECURITY: server echoes a DIFFERENT budget (5000) for a 10000 request.
        # Caching it as 10000 would over-state the budget — refuse, pay nothing.
        wallet = MockWallet()
        client = L402Client(wallet)
        with patch.object(
            client._client, "request",
            side_effect=scripted([credit_challenge(5000)], []),
        ):
            with pytest.raises(L402Error, match="honored 5000 sats of credit, not the 10000"):
                client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
        assert wallet.calls == []

    def test_unavailable_surfaces_message(self):
        client = L402Client(MockWallet())
        with patch.object(
            client._client, "request",
            side_effect=scripted(
                [httpx.Response(status_code=400, json={"error": "Prepaid credit is not enabled for this provider", "code": "credit_unavailable"})],
                [],
            ),
        ):
            with pytest.raises(L402Error, match="not enabled for this provider"):
                client.buy_credit("https://x/y", 25000)

    def test_non_positive_rejects_without_network(self):
        client = L402Client(MockWallet())
        calls = []
        with patch.object(client._client, "request", side_effect=scripted([], calls)):
            with pytest.raises(L402Error):
                client.buy_credit("https://x/y", 0)
        assert calls == []

    def test_over_budget_refused_without_paying(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=9999)
        with patch.object(
            client._client, "request",
            side_effect=scripted([credit_challenge()], []),
        ):
            with pytest.raises(L402BudgetError):
                client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
        assert wallet.calls == []

    def test_clear_credits_drops_credential(self):
        wallet = MockWallet("beef")
        client = L402Client(wallet)
        responses = [
            credit_challenge(),  # buy
            httpx.Response(
                status_code=402,
                headers={"WWW-Authenticate": 'L402 macaroon="single", invoice="lnbc100..."'},
                json={"error": "Payment Required", "amountSats": 100, "paymentHash": "h2"},
            ),
            httpx.Response(status_code=200, json={}),
        ]
        with patch.object(client._client, "request", side_effect=scripted(responses, [])):
            client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
            client.clear_credits()
            resp = client.get("https://acme.gw.bolthub.ai/v1/data")
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc10000...", "lnbc100..."]  # credit + fresh single-use

    def test_batch_fetch_one_payment_per_provider(self):
        wallet = MockWallet("beef")
        client = L402Client(wallet)
        # buy acme, buy bolt, then 3 fetches (2 acme + 1 bolt).
        responses = [
            credit_challenge(),  # buy acme
            credit_challenge(),  # buy bolt
            httpx.Response(status_code=200, json={}),
            httpx.Response(status_code=200, json={}),
            httpx.Response(status_code=200, json={}),
        ]
        with patch.object(client._client, "request", side_effect=scripted(responses, [])):
            res = client.batch_fetch(
                [
                    "https://acme.gw.bolthub.ai/v1/a",
                    "https://acme.gw.bolthub.ai/v1/b",
                    "https://bolt.gw.bolthub.ai/v1/c",
                ],
                credit_sats=10000,
            )
        assert len(res) == 3
        assert wallet.calls == ["lnbc10000...", "lnbc10000..."]  # 2 payments for 3 calls


class TestBuyCreditAsync:
    def test_pays_once_then_reuses(self):
        async def run():
            wallet = MockWallet("beef")
            client = AsyncL402Client(wallet)
            calls = []
            responses = [credit_challenge(), httpx.Response(status_code=200, json={"ok": 1})]

            async def side_effect(method, url, **kwargs):
                h = dict(kwargs.get("headers", {}))
                calls.append({"auth": h.get("Authorization"), "credit": h.get("X-Bolthub-Credit")})
                return responses[len(calls) - 1]

            with patch.object(client._client, "request", side_effect=side_effect):
                await client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
                r = await client.get("https://acme.gw.bolthub.ai/v1/other")
            assert r.status_code == 200
            assert wallet.calls == ["lnbc10000..."]
            assert calls[1]["auth"] == "L402 creditmac:beef"

        asyncio.run(run())

    def test_async_security_refuses_on_mismatch(self):
        async def run():
            wallet = MockWallet()
            client = AsyncL402Client(wallet)

            async def side_effect(method, url, **kwargs):
                return credit_challenge(5000)

            with patch.object(client._client, "request", side_effect=side_effect):
                with pytest.raises(L402Error, match="honored 5000 sats of credit"):
                    await client.buy_credit("https://acme.gw.bolthub.ai/v1/data", 10000)
            assert wallet.calls == []

        asyncio.run(run())

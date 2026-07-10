"""buy_bundle + transparent bundle reuse (AF-P8) — parity with @bolthub/pay.

Pays once for an N-use credential, then request() burns a use per call with no
payment until the gateway 402s (bundle spent), when it falls through to the
normal flow.
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
        calls.append({"auth": h.get("Authorization"), "bundle": h.get("X-Bolthub-Bundle")})
        return responses[len(calls) - 1]

    return side_effect


def bundle_challenge():
    return httpx.Response(
        status_code=402,
        headers={"WWW-Authenticate": 'L402 macaroon="bundlemac", invoice="lnbc8000..."'},
        json={"error": "Payment Required", "amountSats": 8000, "paymentHash": "h1", "bundleUses": 100},
    )


class TestBuyBundleSync:
    def test_pays_once_then_reuses(self):
        wallet = MockWallet("beef")
        client = L402Client(wallet)
        calls = []
        responses = [
            bundle_challenge(),  # buy
            httpx.Response(status_code=200, json={"data": 1}),  # request 1
            httpx.Response(status_code=200, json={"data": 2}),  # request 2
        ]
        with patch.object(client._client, "request", side_effect=scripted(responses, calls)):
            bought = client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)
            assert bought == {"uses": 100, "resource": "https://acme.gw.bolthub.ai/v1/data"}
            assert calls[0]["bundle"] == "100"  # purchase carried the header
            r1 = client.get("https://acme.gw.bolthub.ai/v1/data")
            r2 = client.get("https://acme.gw.bolthub.ai/v1/data")
        assert r1.status_code == 200 and r2.status_code == 200
        assert wallet.calls == ["lnbc8000..."]  # exactly one payment
        assert calls[1]["auth"] == "L402 bundlemac:beef"
        assert calls[2]["auth"] == "L402 bundlemac:beef"

    def test_exhausted_bundle_falls_through(self):
        wallet = MockWallet("beef")
        client = L402Client(wallet)
        calls = []
        responses = [
            bundle_challenge(),  # buy
            httpx.Response(  # reuse -> 402 (spent)
                status_code=402,
                headers={"WWW-Authenticate": 'L402 macaroon="x", invoice="lnbc1..."'},
                text="spent",
            ),
            httpx.Response(  # fall-through single-use 402
                status_code=402,
                headers={"WWW-Authenticate": 'L402 macaroon="single", invoice="lnbc100..."'},
                json={"error": "Payment Required", "amountSats": 100, "paymentHash": "h2"},
            ),
            httpx.Response(status_code=200, json={"ok": True}),  # retry after single-use pay
        ]
        with patch.object(client._client, "request", side_effect=scripted(responses, calls)):
            client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)
            resp = client.get("https://acme.gw.bolthub.ai/v1/data")
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc8000...", "lnbc100..."]  # bundle + single-use

    def test_non_402_rejects(self):
        client = L402Client(MockWallet())
        calls = []
        with patch.object(
            client._client, "request",
            side_effect=scripted([httpx.Response(status_code=200, json={"ok": True})], calls),
        ):
            with pytest.raises(L402Error):
                client.buy_bundle("https://x/y", 100)

    def test_bad_size_surfaces_server_message(self):
        client = L402Client(MockWallet())
        calls = []
        with patch.object(
            client._client, "request",
            side_effect=scripted(
                [httpx.Response(status_code=400, json={"error": "No 250-use bundle. Available sizes: 100, 500", "code": "bundle_size_unavailable"})],
                calls,
            ),
        ):
            with pytest.raises(L402Error, match="Available sizes: 100, 500"):
                client.buy_bundle("https://x/y", 250)

    def test_non_positive_size_rejects_without_network(self):
        client = L402Client(MockWallet())
        calls = []
        with patch.object(client._client, "request", side_effect=scripted([], calls)):
            with pytest.raises(L402Error):
                client.buy_bundle("https://x/y", 0)
        assert calls == []

    def test_budget_drawn_once(self):
        client = L402Client(MockWallet(), budget_sats=10000)
        calls = []
        with patch.object(
            client._client, "request",
            side_effect=scripted([bundle_challenge(), httpx.Response(status_code=200, json={})], calls),
        ):
            client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)
        assert client.total_spent == 8000
        assert client.remaining_budget == 2000

    def test_price_exactly_equal_to_budget_allowed(self):
        # The affordability check is <=, so a bundle priced exactly at the
        # remaining budget spends it to zero.
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=8000)
        with patch.object(
            client._client, "request",
            side_effect=scripted([bundle_challenge(), httpx.Response(status_code=200, json={})], []),
        ):
            client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)
        assert wallet.calls == ["lnbc8000..."]
        assert client.total_spent == 8000
        assert client.remaining_budget == 0

    def test_one_sat_over_budget_refused_without_paying(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=7999)
        with patch.object(
            client._client, "request",
            side_effect=scripted([bundle_challenge(), httpx.Response(status_code=200, json={})], []),
        ):
            with pytest.raises(L402BudgetError):
                client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)
        assert wallet.calls == []  # over-budget bundle never pays
        assert client.total_spent == 0

    def test_max_cost_sats_equal_to_price_allowed(self):
        wallet = MockWallet()
        client = L402Client(wallet)
        with patch.object(
            client._client, "request",
            side_effect=scripted([bundle_challenge(), httpx.Response(status_code=200, json={})], []),
        ):
            client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100, max_cost_sats=8000)
        assert wallet.calls == ["lnbc8000..."]

    def test_max_cost_sats_below_price_refused_without_paying(self):
        wallet = MockWallet()
        client = L402Client(wallet)
        with patch.object(
            client._client, "request",
            side_effect=scripted([bundle_challenge(), httpx.Response(status_code=200, json={})], []),
        ):
            with pytest.raises(L402BudgetError):
                client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100, max_cost_sats=7999)
        assert wallet.calls == []


class TestBuyBundleAsync:
    def test_pays_once_then_reuses(self):
        async def run():
            wallet = MockWallet("beef")
            client = AsyncL402Client(wallet)
            calls = []
            responses = [
                bundle_challenge(),
                httpx.Response(status_code=200, json={"ok": 1}),
            ]

            async def side_effect(method, url, **kwargs):
                h = dict(kwargs.get("headers", {}))
                calls.append({"auth": h.get("Authorization"), "bundle": h.get("X-Bolthub-Bundle")})
                return responses[len(calls) - 1]

            with patch.object(client._client, "request", side_effect=side_effect):
                await client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)
                r = await client.get("https://acme.gw.bolthub.ai/v1/data")
            assert r.status_code == 200
            assert wallet.calls == ["lnbc8000..."]
            assert calls[1]["auth"] == "L402 bundlemac:beef"

        asyncio.run(run())

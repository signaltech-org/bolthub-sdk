"""P4 — AsyncL402Client + async wallets.

The SCENARIOS table is exercised against BOTH the sync L402Client and the
AsyncL402Client to assert behavioural parity.
"""

import asyncio
from dataclasses import dataclass, field

import httpx
import pytest

from bolthub import (
    L402Client,
    AsyncL402Client,
    L402BudgetError,
    AsyncLndWallet,
    AsyncLnbitsWallet,
    AsyncPhoenixdWallet,
    SyncWalletAdapter,
)

URL = "https://gw.example.com/v1/data"
VALID_SESSION = "sess-tok-123"
NONDECODABLE = "lnbcplaceholder"


class MockWallet:
    def __init__(self, preimage="pre"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


def gateway(amount_sats=100, *, invoice="lnbc1u1pdata", issue_session=False, always_ok=False):
    stats = {"paid": 0, "session_used": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if always_ok:
            return httpx.Response(200, json={"ok": True})
        auth = request.headers.get("authorization", "")
        sess = request.headers.get("x-session-token", "")
        if auth.startswith("L402 "):
            stats["paid"] += 1
            headers = {}
            if issue_session:
                headers["X-Session-Token"] = VALID_SESSION
                headers["X-Session-Expires"] = "2999-01-01T00:00:00Z"
            return httpx.Response(200, headers=headers, json={"ok": True})
        if sess == VALID_SESSION:
            stats["session_used"] += 1
            return httpx.Response(200, json={"ok": True})
        body = {"amountSats": amount_sats} if amount_sats is not None else {"error": "pay"}
        return httpx.Response(
            402,
            headers={"WWW-Authenticate": f'L402 macaroon="mac", invoice="{invoice}"'},
            json=body,
        )

    return handler, stats


@dataclass
class Scenario:
    name: str
    client_kwargs: dict = field(default_factory=dict)
    gateway_kwargs: dict = field(default_factory=dict)
    expect_error: bool = False
    expect_spent: int = 0
    expect_calls: int = 0


SCENARIOS = [
    Scenario("passthrough", gateway_kwargs={"always_ok": True}, expect_spent=0, expect_calls=0),
    Scenario("pay", client_kwargs={"budget_sats": 1000}, expect_spent=100, expect_calls=1),
    Scenario("budget_exceeded", client_kwargs={"budget_sats": 50}, expect_error=True),
    Scenario("per_request_limit", client_kwargs={"max_per_request_sats": 10}, expect_error=True),
    Scenario(
        "priceless_no_max",
        gateway_kwargs={"amount_sats": None, "invoice": NONDECODABLE},
        expect_error=True,
    ),
    Scenario(
        "priceless_with_cap",
        client_kwargs={"max_per_request_sats": 200},
        gateway_kwargs={"amount_sats": None, "invoice": NONDECODABLE},
        expect_spent=200,
        expect_calls=1,
    ),
]


class TestParitySync:
    @pytest.mark.parametrize("sc", SCENARIOS, ids=lambda s: s.name)
    def test(self, sc):
        wallet = MockWallet()
        handler, _ = gateway(**sc.gateway_kwargs)
        client = L402Client(wallet, **sc.client_kwargs)
        client._client = httpx.Client(transport=httpx.MockTransport(handler))
        try:
            if sc.expect_error:
                with pytest.raises(L402BudgetError):
                    client.get(URL)
            else:
                assert client.get(URL).status_code == 200
            assert client.total_spent == sc.expect_spent
            assert len(wallet.calls) == sc.expect_calls
        finally:
            client.close()


class TestParityAsync:
    @pytest.mark.parametrize("sc", SCENARIOS, ids=lambda s: s.name)
    def test(self, sc):
        async def go():
            wallet = MockWallet()  # sync wallet -> auto-wrapped, paid in a thread
            handler, _ = gateway(**sc.gateway_kwargs)
            client = AsyncL402Client(wallet, **sc.client_kwargs)
            client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            try:
                if sc.expect_error:
                    with pytest.raises(L402BudgetError):
                        await client.get(URL)
                else:
                    resp = await client.get(URL)
                    assert resp.status_code == 200
                assert client.total_spent == sc.expect_spent
                assert len(wallet.calls) == sc.expect_calls
            finally:
                await client.aclose()

        asyncio.run(go())


class TestAsyncSessionReuse:
    def test_second_request_uses_session(self):
        async def go():
            wallet = MockWallet()
            handler, stats = gateway(issue_session=True)
            client = AsyncL402Client(wallet, budget_sats=1000)
            client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            try:
                r1 = await client.get(URL)
                r2 = await client.get(URL)
                assert r1.status_code == 200 and r2.status_code == 200
                assert wallet.calls == ["lnbc1u1pdata"]  # paid only once
                assert stats["session_used"] == 1
            finally:
                await client.aclose()

        asyncio.run(go())


# ----------------------------------------------------------- async wallets

class _FakeAsyncClient:
    """Stand-in for httpx.AsyncClient that returns a canned response."""

    def __init__(self, response):
        self._response = response
        self.last_call = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, **kwargs):
        self.last_call = (url, kwargs)
        self._response.request = httpx.Request("POST", url)
        return self._response


def _patch_async_client(monkeypatch, response):
    fake = _FakeAsyncClient(response)
    monkeypatch.setattr("bolthub.awallets.httpx.AsyncClient", lambda *a, **k: fake)
    return fake


class TestAsyncWallets:
    def test_lnd_pays(self, monkeypatch):
        resp = httpx.Response(200, json={"result": {"payment_preimage": "abc123"}})
        fake = _patch_async_client(monkeypatch, resp)
        w = AsyncLndWallet(host="https://lnd.example.com/", macaroon="deadbeef")
        assert asyncio.run(w.pay_invoice("lnbc1...")) == "abc123"
        assert fake.last_call[0] == "https://lnd.example.com/v2/router/send"
        assert fake.last_call[1]["headers"]["Grpc-Metadata-macaroon"] == "deadbeef"

    def test_lnd_missing_preimage(self, monkeypatch):
        _patch_async_client(monkeypatch, httpx.Response(200, json={"result": {}}))
        w = AsyncLndWallet(host="https://lnd.example.com", macaroon="m")
        with pytest.raises(RuntimeError, match="missing preimage"):
            asyncio.run(w.pay_invoice("lnbc1..."))

    def test_lnbits_pays(self, monkeypatch):
        fake = _patch_async_client(monkeypatch, httpx.Response(200, json={"preimage": "lnbits_pre"}))
        w = AsyncLnbitsWallet(url="https://lnbits.example.com", admin_key="key1")
        assert asyncio.run(w.pay_invoice("lnbc1...")) == "lnbits_pre"
        assert fake.last_call[1]["headers"]["X-Api-Key"] == "key1"

    def test_phoenixd_pays(self, monkeypatch):
        fake = _patch_async_client(monkeypatch, httpx.Response(200, json={"paymentPreimage": "phx"}))
        w = AsyncPhoenixdWallet(url="http://localhost:9740", password="pass")
        assert asyncio.run(w.pay_invoice("lnbc1...")) == "phx"
        assert "Basic" in fake.last_call[1]["headers"]["Authorization"]

    def test_sync_wallet_adapter_runs_in_thread(self):
        sync_wallet = MockWallet("synced")
        adapter = SyncWalletAdapter(sync_wallet)
        assert asyncio.run(adapter.pay_invoice("lnbc1...")) == "synced"
        assert sync_wallet.calls == ["lnbc1..."]

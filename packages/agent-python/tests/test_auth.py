"""P5 — L402Auth against a local MockTransport gateway (sync + async)."""

import asyncio

import httpx
import pytest

from bolthub import L402Auth, L402BudgetError

URL = "https://gw.example.com/v1/data"
VALID_SESSION = "sess-tok-123"


class MockWallet:
    def __init__(self, preimage="pre"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


class AsyncMockWallet:
    def __init__(self, preimage="apre"):
        self._preimage = preimage
        self.calls = []

    async def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


def gateway(amount_sats=100, *, invoice="lnbc1u1pdata", issue_session=False):
    """A MockTransport handler emulating an L402 gateway.

    Returns 200 when payment proof (Authorization) or a valid session token is
    present, else a 402 challenge.
    """
    stats = {"paid": 0, "session_used": 0}

    def handler(request: httpx.Request) -> httpx.Response:
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


# ----------------------------------------------------------------- sync flow

class TestSyncAuth:
    def test_pays_and_succeeds(self):
        wallet = MockWallet()
        auth = L402Auth(wallet, budget_sats=1000)
        handler, stats = gateway(amount_sats=100)
        with httpx.Client(auth=auth, transport=httpx.MockTransport(handler)) as client:
            resp = client.get(URL)
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1u1pdata"]
        assert auth.total_spent == 100
        assert stats["paid"] == 1

    def test_budget_exceeded_does_not_pay(self):
        wallet = MockWallet()
        auth = L402Auth(wallet, budget_sats=50)
        handler, _ = gateway(amount_sats=100)
        with httpx.Client(auth=auth, transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(L402BudgetError):
                client.get(URL)
        assert wallet.calls == []
        assert auth.total_spent == 0

    def test_reads_body_price_via_requires_response_body(self):
        # Invoice is non-decodable, so the only price signal is the body. If the
        # body were not read, the amount would be unknown and "cap" with no
        # ceiling would refuse instead of paying 30.
        wallet = MockWallet()
        auth = L402Auth(wallet, budget_sats=1000)
        handler, _ = gateway(amount_sats=30, invoice="lnbcplaceholder")
        with httpx.Client(auth=auth, transport=httpx.MockTransport(handler)) as client:
            resp = client.get(URL)
        assert resp.status_code == 200
        assert auth.total_spent == 30

    def test_session_reuse_skips_second_payment(self):
        wallet = MockWallet()
        auth = L402Auth(wallet, budget_sats=1000)
        handler, stats = gateway(amount_sats=100, issue_session=True)
        with httpx.Client(auth=auth, transport=httpx.MockTransport(handler)) as client:
            r1 = client.get(URL)
            r2 = client.get(URL)
        assert r1.status_code == 200 and r2.status_code == 200
        assert wallet.calls == ["lnbc1u1pdata"]  # paid only once
        assert stats["paid"] == 1
        assert stats["session_used"] == 1


# ---------------------------------------------------------------- async flow

def _run(coro):
    return asyncio.run(coro)


class TestAsyncAuth:
    def test_pays_with_sync_wallet_in_thread(self):
        wallet = MockWallet()  # sync wallet under the async flow -> to_thread
        auth = L402Auth(wallet, budget_sats=1000)
        handler, _ = gateway(amount_sats=100)

        async def go():
            async with httpx.AsyncClient(
                auth=auth, transport=httpx.MockTransport(handler)
            ) as client:
                return await client.get(URL)

        resp = _run(go())
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1u1pdata"]
        assert auth.total_spent == 100

    def test_pays_with_async_wallet(self):
        wallet = AsyncMockWallet()
        auth = L402Auth(wallet, budget_sats=1000)
        handler, _ = gateway(amount_sats=100)

        async def go():
            async with httpx.AsyncClient(
                auth=auth, transport=httpx.MockTransport(handler)
            ) as client:
                return await client.get(URL)

        resp = _run(go())
        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1u1pdata"]
        assert auth.total_spent == 100

    def test_budget_exceeded_does_not_pay(self):
        wallet = AsyncMockWallet()
        auth = L402Auth(wallet, budget_sats=50)
        handler, _ = gateway(amount_sats=100)

        async def go():
            async with httpx.AsyncClient(
                auth=auth, transport=httpx.MockTransport(handler)
            ) as client:
                with pytest.raises(L402BudgetError):
                    await client.get(URL)

        _run(go())
        assert wallet.calls == []
        assert auth.total_spent == 0

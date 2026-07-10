import pytest
from unittest.mock import patch
import httpx

from bolthub import L402Client, L402Error, L402BudgetError


class MockWallet:
    def __init__(self, preimage="abc123"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


def make_402_response(amount_sats=100):
    return httpx.Response(
        status_code=402,
        headers={
            "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."',
        },
        json={"error": "Payment Required", "amountSats": amount_sats},
    )


def make_200_response(data=None):
    return httpx.Response(status_code=200, json=data or {"ok": True})


class TestL402Client:
    def test_returns_response_if_not_402(self):
        wallet = MockWallet()
        client = L402Client(wallet)
        with patch.object(client._client, "request", return_value=make_200_response()):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert len(wallet.calls) == 0

    def test_handles_402_and_retries(self):
        wallet = MockWallet("preimage123")
        client = L402Client(wallet)
        responses = [make_402_response(), make_200_response()]
        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            resp = responses[call_count]
            call_count += 1
            return resp

        with patch.object(client._client, "request", side_effect=side_effect):
            resp = client.get("https://example.com/api")

        assert resp.status_code == 200
        assert wallet.calls == ["lnbc1000..."]

    def test_raises_on_402_without_challenge(self):
        wallet = MockWallet()
        client = L402Client(wallet)
        bare_402 = httpx.Response(status_code=402, json={"error": "pay"})
        with patch.object(client._client, "request", return_value=bare_402):
            with pytest.raises(L402Error, match="Failed to parse"):
                client.get("https://example.com/api")

    def test_budget_exceeded(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=50)
        with patch.object(client._client, "request", return_value=make_402_response(100)):
            with pytest.raises(L402BudgetError, match="exceed total budget"):
                client.get("https://example.com/api")

    def test_per_request_limit(self):
        wallet = MockWallet()
        client = L402Client(wallet, max_per_request_sats=10)
        with patch.object(client._client, "request", return_value=make_402_response(100)):
            with pytest.raises(L402BudgetError, match="per-request limit"):
                client.get("https://example.com/api")

    def test_tracks_spent(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=1000)
        assert client.total_spent == 0
        assert client.remaining_budget == 1000

    def test_context_manager(self):
        wallet = MockWallet()
        with L402Client(wallet) as client:
            assert client is not None

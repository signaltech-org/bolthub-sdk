"""P1 — budget enforcement when a 402 carries no body price."""

import pytest
from unittest.mock import patch
import httpx

from bolthub import L402Client, L402BudgetError


class MockWallet:
    def __init__(self, preimage="abc123"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


class FailWallet:
    def pay_invoice(self, bolt11: str) -> str:
        raise RuntimeError("pay failed")


# A non-decodable invoice (no bech32 separator) so the only price signal is
# whatever we put in the body / header.
PRICELESS_INVOICE = "lnbcplaceholder"


def challenge_402(invoice=PRICELESS_INVOICE, amount_sats=None, extra_headers=None):
    headers = {"WWW-Authenticate": f'L402 macaroon="mac123", invoice="{invoice}"'}
    if extra_headers:
        headers.update(extra_headers)
    body = {"error": "Payment Required"}
    if amount_sats is not None:
        body["amountSats"] = amount_sats
    return httpx.Response(402, headers=headers, json=body)


def ok_200():
    return httpx.Response(200, json={"ok": True})


def seq(client, *responses):
    it = iter(responses)
    return patch.object(client._client, "request", side_effect=lambda *a, **k: next(it))


class TestPricelessPolicy:
    def test_refused_without_max_per_request(self):
        wallet = MockWallet()
        client = L402Client(wallet)  # default on_unknown_amount="cap"
        with seq(client, challenge_402()):
            with pytest.raises(L402BudgetError):
                client.get("https://example.com/api")
        assert wallet.calls == []  # never paid blind
        assert client.total_spent == 0

    def test_capped_with_max_per_request(self):
        wallet = MockWallet()
        client = L402Client(wallet, max_per_request_sats=200)
        with seq(client, challenge_402(), ok_200()):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert wallet.calls == [PRICELESS_INVOICE]
        assert client.total_spent == 200  # charged the ceiling

    def test_cap_still_respects_total_budget(self):
        wallet = MockWallet()
        client = L402Client(wallet, max_per_request_sats=200, budget_sats=100)
        with seq(client, challenge_402()):
            with pytest.raises(L402BudgetError, match="exceed total budget"):
                client.get("https://example.com/api")
        assert wallet.calls == []

    def test_refuse_policy_refuses_even_with_max(self):
        wallet = MockWallet()
        client = L402Client(wallet, max_per_request_sats=200, on_unknown_amount="refuse")
        with seq(client, challenge_402()):
            with pytest.raises(L402BudgetError):
                client.get("https://example.com/api")
        assert wallet.calls == []

    def test_allow_policy_pays_uncounted(self):
        wallet = MockWallet()
        client = L402Client(wallet, on_unknown_amount="allow")
        with seq(client, challenge_402(), ok_200()):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert wallet.calls == [PRICELESS_INVOICE]
        assert client.total_spent == 0


class TestPriceSources:
    def test_amount_decoded_from_invoice_enforces_budget(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=1000)
        # lnbc2500u -> 250_000 sats, far above the 1000-sat budget.
        with seq(client, challenge_402(invoice="lnbc2500u1pdata")):
            with pytest.raises(L402BudgetError, match="exceed total budget"):
                client.get("https://example.com/api")
        assert wallet.calls == []

    def test_amount_decoded_from_invoice_paid_and_counted(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=1000)
        # lnbc50n -> 5 sats.
        with seq(client, challenge_402(invoice="lnbc50n1pdata"), ok_200()):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert client.total_spent == 5

    def test_price_header_used_when_body_and_invoice_silent(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=10, price_header="X-Price-Sats")
        with seq(client, challenge_402(extra_headers={"X-Price-Sats": "50"})):
            with pytest.raises(L402BudgetError, match="exceed total budget"):
                client.get("https://example.com/api")
        assert wallet.calls == []

    def test_body_amount_takes_priority_over_invoice(self):
        wallet = MockWallet()
        client = L402Client(wallet, budget_sats=1000)
        # Body says 10; invoice would decode to 250_000. Body wins.
        with seq(client, challenge_402(invoice="lnbc2500u1pdata", amount_sats=10), ok_200()):
            resp = client.get("https://example.com/api")
        assert resp.status_code == 200
        assert client.total_spent == 10


class TestReservation:
    def test_payment_failure_rolls_back(self):
        client = L402Client(FailWallet(), budget_sats=1000)
        with seq(client, challenge_402(amount_sats=100)):
            with pytest.raises(RuntimeError, match="pay failed"):
                client.get("https://example.com/api")
        assert client.total_spent == 0  # reservation rolled back


def test_invalid_unknown_policy_rejected():
    with pytest.raises(ValueError):
        L402Client(MockWallet(), on_unknown_amount="bogus")

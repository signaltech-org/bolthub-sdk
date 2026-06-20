"""P2 — concurrent requests must never exceed the budget."""

from concurrent.futures import ThreadPoolExecutor

from unittest.mock import patch
import httpx

from bolthub import L402Client, L402BudgetError


class MockWallet:
    def __init__(self, preimage="p"):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)  # list.append is atomic under the GIL
        return self._preimage


def smart_transport(method, url, **kwargs):
    """Return 200 once an L402 Authorization header is present, else a 1-sat 402.

    This lets every thread independently drive a full 402 -> pay -> retry cycle
    without a shared response sequence.
    """
    headers = kwargs.get("headers") or {}
    if any(k.lower() == "authorization" for k in headers):
        return httpx.Response(200, json={"ok": True})
    return httpx.Response(
        402,
        headers={"WWW-Authenticate": 'L402 macaroon="m", invoice="lnbcplaceholder"'},
        json={"amountSats": 1},
    )


def test_concurrent_requests_never_exceed_budget():
    wallet = MockWallet()
    budget = 20
    n_requests = 50
    client = L402Client(wallet, budget_sats=budget)

    def worker():
        try:
            return client.get("https://example.com/api").status_code
        except L402BudgetError:
            return "budget"

    with patch.object(client._client, "request", side_effect=smart_transport):
        with ThreadPoolExecutor(max_workers=16) as ex:
            results = [f.result() for f in [ex.submit(worker) for _ in range(n_requests)]]

    paid = [r for r in results if r == 200]
    refused = [r for r in results if r == "budget"]

    assert len(paid) == budget                 # exactly budget requests succeed
    assert len(refused) == n_requests - budget  # the rest are refused
    assert client.total_spent == budget         # exact, never over
    assert client.remaining_budget == 0
    assert len(wallet.calls) == budget          # paid exactly budget times

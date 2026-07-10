"""One ``Budget`` across the HTTP-402 and MCP payment paths — the Python
mirror of ``@bolthub/pay``'s shared-budget guarantees (``budget.test.ts`` /
``unified-budget.test.ts``): both clients draw from the same pool, refusals
reserve nothing, and failed payments roll back.
"""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest

from bolthub import Budget, L402BudgetError, L402Client, ToolClient, l402_payer
from bolthub.errors import PaymentBudgetError


class MockWallet:
    def __init__(self, preimage: str = "ab" * 32, fail: bool = False):
        self.preimage = preimage
        self.fail = fail
        self.calls: list[str] = []

    def pay_invoice(self, invoice: str) -> str:
        if self.fail:
            raise RuntimeError("simulated wallet failure")
        self.calls.append(invoice)
        return self.preimage


def make_402(amount_sats: int = 5) -> httpx.Response:
    return httpx.Response(
        status_code=402,
        json={"amountSats": amount_sats},
        headers={"WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc1000..."'},
    )


def make_200() -> httpx.Response:
    return httpx.Response(status_code=200, json={"ok": True})


def paid_flow(amount_sats: int = 5):
    """Side effect: first call returns a 402 challenge, the retry a 200."""
    responses = iter([make_402(amount_sats), make_200()])

    def side_effect(*args, **kwargs):
        return next(responses)

    return side_effect


class TestSharedBudgetConstruction:
    def test_budget_and_budget_sats_are_mutually_exclusive(self):
        with pytest.raises(ValueError, match="not both"):
            L402Client(MockWallet(), budget=Budget(), budget_sats=10)

    def test_async_client_rejects_both_too(self):
        from bolthub import AsyncL402Client

        with pytest.raises(ValueError, match="not both"):
            AsyncL402Client(MockWallet(), budget=Budget(), budget_sats=10)


class TestSharedPool:
    def test_l402_client_draws_from_and_reports_the_shared_pool(self):
        budget = Budget(max_total={"sat": 100})
        paid: list[dict] = []
        client = L402Client(MockWallet(), budget=budget, on_paid=paid.append)

        with patch.object(client._client, "request", side_effect=paid_flow(40)):
            resp = client.get("https://x.gw.bolthub.ai/v1/data")

        assert resp.status_code == 200
        assert budget.spent_for("sat") == 40
        assert client.total_spent == 40
        assert client.remaining_budget == 60
        assert paid == [
            {
                "scheme": "l402",
                "amount": 40,
                "asset": "sat",
                "resource": "https://x.gw.bolthub.ai/v1/data",
                # Receipt fields (AF-B2): additive enrichment of on_paid.
                "preimage": "ab" * 32,
                "invoice": "lnbc1000...",
                "payment_hash": None,  # this 402 body carries no paymentHash
            }
        ]

    def test_spend_on_the_mcp_path_blocks_the_http_path(self):
        budget = Budget(max_total={"sat": 6})
        budget.reserve("sat", 5)  # as if a ToolClient payment landed first

        client = L402Client(MockWallet(), budget=budget)
        with patch.object(client._client, "request", side_effect=paid_flow(5)):
            with pytest.raises(L402BudgetError):
                client.get("https://x.gw.bolthub.ai/v1/data")
        assert budget.spent_for("sat") == 5  # the refusal reserved nothing

    def test_http_spend_blocks_the_tool_client(self):
        budget = Budget(max_total={"sat": 10})
        client = L402Client(MockWallet(), budget=budget)
        with patch.object(client._client, "request", side_effect=paid_flow(10)):
            client.get("https://x.gw.bolthub.ai/v1/data")
        assert budget.spent_for("sat") == 10

        tool = ToolClient(payers=[l402_payer(MockWallet())], budget=budget)
        challenge_result = {
            "isError": True,
            "content": [{"type": "text", "text": "Payment required"}],
            "_meta": {
                "ai.bolthub/payment": {
                    "version": "0.1",
                    "status": "payment_required",
                    "resource": "paid_tool",
                    "offers": [
                        {"scheme": "l402", "amount": 5, "asset": "sat", "invoice": "lnbc5...", "token": "tok"}
                    ],
                }
            },
        }
        with pytest.raises(PaymentBudgetError):
            tool.call(lambda meta=None: challenge_result)
        assert budget.spent_for("sat") == 10

    def test_wallet_failure_rolls_back_the_shared_reservation(self):
        budget = Budget(max_total={"sat": 5})
        client = L402Client(MockWallet(fail=True), budget=budget)
        with patch.object(client._client, "request", side_effect=paid_flow(5)):
            with pytest.raises(RuntimeError):
                client.get("https://x.gw.bolthub.ai/v1/data")
        assert budget.spent_for("sat") == 0  # rolled back — headroom restored

    def test_budget_zero_means_free_tools_only(self):
        budget = Budget(max_total={"sat": 0})
        client = L402Client(MockWallet(), budget=budget)
        with patch.object(client._client, "request", side_effect=paid_flow(5)):
            with pytest.raises(L402BudgetError):
                client.get("https://x.gw.bolthub.ai/v1/data")
        # free responses still pass through untouched
        with patch.object(client._client, "request", return_value=make_200()):
            assert client.get("https://x.gw.bolthub.ai/v1/free").status_code == 200


class TestPerRequestCaps:
    def test_budget_max_per_call_caps_requests_when_max_per_request_unset(self):
        budget = Budget(max_per_call={"sat": 10})
        client = L402Client(MockWallet(), budget=budget)
        with patch.object(client._client, "request", side_effect=paid_flow(25)):
            with pytest.raises(L402BudgetError, match="per-request limit"):
                client.get("https://x.gw.bolthub.ai/v1/data")

    def test_max_cost_sats_tightens_the_cap_for_one_call_only(self):
        budget = Budget(max_total={"sat": 1000})
        wallet = MockWallet()
        client = L402Client(wallet, budget=budget)
        with patch.object(client._client, "request", side_effect=paid_flow(25)):
            with pytest.raises(L402BudgetError, match="per-request limit"):
                client.get("https://x.gw.bolthub.ai/v1/data", max_cost_sats=10)
        assert budget.spent_for("sat") == 0
        assert wallet.calls == []
        # the next call without the override pays fine
        with patch.object(client._client, "request", side_effect=paid_flow(25)):
            assert client.get("https://x.gw.bolthub.ai/v1/data").status_code == 200
        assert budget.spent_for("sat") == 25

    def test_max_cost_sats_never_loosens_the_client_cap(self):
        client = L402Client(MockWallet(), max_per_request_sats=10)
        with patch.object(client._client, "request", side_effect=paid_flow(15)):
            with pytest.raises(L402BudgetError, match="per-request limit"):
                client.get("https://x.gw.bolthub.ai/v1/data", max_cost_sats=100)

    def test_per_request_on_paid_reports_the_exact_call_cost(self):
        client = L402Client(MockWallet())
        costs: list[int] = []
        with patch.object(client._client, "request", side_effect=paid_flow(7)):
            client.get(
                "https://x.gw.bolthub.ai/v1/data",
                on_paid=lambda info: costs.append(info["amount"]),
            )
        assert costs == [7]


class TestAsyncSharedPool:
    def test_async_client_draws_from_the_shared_pool(self):
        import asyncio

        from bolthub import AsyncL402Client

        async def go():
            budget = Budget(max_total={"sat": 100})
            client = AsyncL402Client(MockWallet(), budget=budget)
            responses = iter([make_402(40), make_200()])

            async def side_effect(*args, **kwargs):
                return next(responses)

            with patch.object(client._client, "request", side_effect=side_effect):
                resp = await client.get("https://x.gw.bolthub.ai/v1/data")
            await client.aclose()
            return budget, client, resp

        budget, client, resp = asyncio.run(go())
        assert resp.status_code == 200
        assert budget.spent_for("sat") == 40
        assert client.total_spent == 40

    def test_async_refusal_past_max_total(self):
        import asyncio

        from bolthub import AsyncL402Client

        async def go():
            budget = Budget(max_total={"sat": 10})
            budget.reserve("sat", 8)
            client = AsyncL402Client(MockWallet(), budget=budget)

            async def side_effect(*args, **kwargs):
                return make_402(5)

            with patch.object(client._client, "request", side_effect=side_effect):
                with pytest.raises(L402BudgetError):
                    await client.get("https://x.gw.bolthub.ai/v1/data")
            await client.aclose()
            return budget

        budget = asyncio.run(go())
        assert budget.spent_for("sat") == 8

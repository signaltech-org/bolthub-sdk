import math

import pytest

from bolthub import Budget, PaymentBudgetError, PaymentError, ToolClient


class TestBudget:
    def test_tracks_per_asset_spend_independently(self):
        b = Budget(max_total={"sat": 100, "usd": 5})
        b.reserve("sat", 60)
        b.reserve("usd", 2)
        assert b.spent_for("sat") == 60
        assert b.spent_for("usd") == 2
        assert b.remaining_for("sat") == 40
        assert b.remaining_for("usd") == 3

    def test_unset_asset_is_unlimited(self):
        b = Budget(max_total={"sat": 10})
        assert b.remaining_for("usd") == math.inf
        b.reserve("usd", 1_000_000)
        assert b.spent_for("usd") == 1_000_000

    def test_reserve_raises_past_max_total(self):
        b = Budget(max_total={"sat": 100})
        b.reserve("sat", 100)
        with pytest.raises(PaymentBudgetError, match="total budget"):
            b.reserve("sat", 1)
        assert b.spent_for("sat") == 100  # failed reserve counts nothing

    def test_budget_error_is_a_payment_error(self):
        b = Budget(max_total={"sat": 1})
        with pytest.raises(PaymentError):
            b.reserve("sat", 2)

    def test_max_per_call_caps_a_single_reservation(self):
        b = Budget(max_per_call={"sat": 50})
        with pytest.raises(PaymentBudgetError, match="per-call cap"):
            b.reserve("sat", 51)
        b.reserve("sat", 50)
        assert b.spent_for("sat") == 50

    def test_per_call_override_tightens_but_never_loosens(self):
        b = Budget(max_per_call={"sat": 50})
        with pytest.raises(PaymentBudgetError, match="per-call cap"):
            b.reserve("sat", 30, 20)
        # an override above max_per_call must not loosen it
        with pytest.raises(PaymentBudgetError, match="per-call cap"):
            b.reserve("sat", 60, 100)
        b.reserve("sat", 20, 20)
        assert b.spent_for("sat") == 20

    def test_per_call_for(self):
        b = Budget(max_per_call={"sat": 50})
        assert b.per_call_for("sat") == 50
        assert b.per_call_for("usd") == math.inf

    def test_rollback_restores_headroom(self):
        b = Budget(max_total={"sat": 100})
        b.reserve("sat", 100)
        b.rollback("sat", 100)
        assert b.spent_for("sat") == 0
        b.reserve("sat", 100)  # fits again

    def test_check_rejects_zero_negative_and_non_finite_amounts(self):
        b = Budget()
        assert b.check("sat", 0) == "invalid offer amount"
        assert b.check("sat", -5) == "invalid offer amount"
        assert b.check("sat", math.nan) == "invalid offer amount"
        assert b.check("sat", math.inf) == "invalid offer amount"
        assert b.check("sat", "10") == "invalid offer amount"
        assert b.check("sat", True) == "invalid offer amount"
        assert b.check("sat", 1) is None

    def test_sequential_reserves_cannot_jointly_overspend(self):
        b = Budget(max_total={"sat": 100})
        b.reserve("sat", 60)
        with pytest.raises(PaymentBudgetError):
            b.reserve("sat", 60)


class _NoopPayer:
    scheme = "l402"

    def pay(self, offer):
        return {"proof": "tok:pre", "amount": offer["amount"], "asset": offer["asset"]}


class TestSharedBudget:
    def test_tool_client_with_external_budget_reads_and_writes_the_shared_pool(self):
        budget = Budget(max_total={"sat": 100})
        tool = ToolClient([_NoopPayer()], budget=budget)
        budget.reserve("sat", 80)  # spend arrives from elsewhere
        assert tool.spent_for("sat") == 80
        assert tool.remaining_for("sat") == 20

    def test_tool_client_rejects_budget_alongside_limits(self):
        with pytest.raises(ValueError, match="not both"):
            ToolClient([_NoopPayer()], budget=Budget(), max_total={"sat": 1})
        with pytest.raises(ValueError, match="not both"):
            ToolClient([_NoopPayer()], budget=Budget(), max_per_call={"sat": 1})

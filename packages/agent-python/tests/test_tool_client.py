import pytest

from bolthub import (
    PaymentBudgetError,
    PaymentError,
    ToolClient,
    create_paywall,
    get_payment_challenge,
    l402_payer,
    l402_rail,
    random_preimage,
    sha256_hex,
)

SECRET = "test-secret-at-least-thirty-two-bytes-long!!"


class FakeMcp:
    """A fake MCP transport: a seller registers wrapped handlers via ``tool()``,
    a buyer calls them via ``call_tool()``. It propagates request ``_meta`` to
    ``extra["_meta"]``, exactly the contract the SDK relies on. Seller and
    buyer run real code; only the wire is faked."""

    def __init__(self):
        self._handlers = {}

    def tool(self, name, description, schema, handler):
        self._handlers[name] = handler

    def call_tool(self, *, name, arguments=None, meta=None):
        handler = self._handlers[name]
        return handler(arguments or {}, {"_meta": meta})


class MockLightning:
    """Simulates the whole Lightning settlement: the invoice provider (seller)
    and the wallet (buyer) share a preimage table keyed by invoice string."""

    def __init__(self):
        self._by_invoice = {}
        outer = self

        class _Provider:
            def create_invoice(self, amount_sat, memo):
                preimage = random_preimage()
                payment_hash = sha256_hex(preimage)
                invoice = f"lnbcmock{amount_sat}_{payment_hash[:8]}"
                outer._by_invoice[invoice] = preimage
                return invoice, payment_hash

        class _Wallet:
            def pay_invoice(self, bolt11):
                if bolt11 not in outer._by_invoice:
                    raise RuntimeError(f"unknown invoice: {bolt11}")
                return outer._by_invoice[bolt11]

        self.invoice_provider = _Provider()
        self.wallet = _Wallet()


class UnpayableRail:
    """A rail with a scheme no configured payer settles ("no payer" path)."""

    scheme = "mock"
    assets = ("sat",)

    def create_offer(self, price, resource):
        return {"scheme": "mock", "amount": price["amount"], "asset": price["asset"]}

    def verify(self, proof, *, resource, price):
        return {"ok": True}


def paid_text(result):
    return result["content"][0]["text"]


def premium_handler(args, extra):
    return {"content": [{"type": "text", "text": "PAID CONTENT"}]}


class TestToolClientEndToEnd:
    def test_an_unpaid_call_is_challenged_paid_and_unlocked(self):
        ln = MockLightning()
        mcp = FakeMcp()
        pay = create_paywall(rails=[l402_rail(SECRET, ln.invoice_provider)])
        pay.tool(mcp, "premium", "Premium data", {}, premium_handler, price={"amount": 2000})

        stages = []
        paid = []
        buyer = ToolClient(
            [l402_payer(ln.wallet)],
            max_total={"sat": 10_000},
            on_paid=paid.append,
            on_stage=stages.append,
        )
        result = buyer.call_tool(mcp, "premium")

        assert paid_text(result) == "PAID CONTENT"
        assert "isError" not in result
        assert buyer.spent_for("sat") == 2000
        assert buyer.remaining_for("sat") == 8000
        assert stages == ["calling", "paying", "retrying"]
        assert paid == [
            {"scheme": "l402", "amount": 2000, "asset": "sat", "resource": "premium"}
        ]

    def test_a_per_call_cap_below_the_price_refuses_to_pay(self):
        ln = MockLightning()
        mcp = FakeMcp()
        pay = create_paywall(rails=[l402_rail(SECRET, ln.invoice_provider)])
        pay.tool(mcp, "premium", "Premium", {}, premium_handler, price={"amount": 2000})

        buyer = ToolClient([l402_payer(ln.wallet)], max_per_call={"sat": 1000})
        with pytest.raises(PaymentBudgetError, match="exceed the budget"):
            buyer.call_tool(mcp, "premium")
        assert buyer.spent_for("sat") == 0

    def test_no_payer_for_the_offered_rail_returns_the_unpaid_challenge(self):
        mcp = FakeMcp()
        pay = create_paywall(rails=[UnpayableRail()])
        pay.tool(mcp, "premium", "Premium", {}, premium_handler, price={"amount": 2000})

        # Buyer only holds an L402 payer; the tool only offers the "mock" scheme.
        buyer = ToolClient([l402_payer(MockLightning().wallet)])
        result = buyer.call_tool(mcp, "premium")
        assert result["isError"] is True
        assert get_payment_challenge(result)["resource"] == "premium"
        assert buyer.spent_for("sat") == 0

    def test_a_free_tool_passes_straight_through(self):
        mcp = FakeMcp()
        mcp.tool(
            "free", "Free", {}, lambda args, extra: {"content": [{"type": "text", "text": "NO CHARGE"}]}
        )
        buyer = ToolClient([l402_payer(MockLightning().wallet)])
        assert paid_text(buyer.call_tool(mcp, "free")) == "NO CHARGE"

    def test_a_failed_payment_rolls_the_reservation_back(self):
        ln = MockLightning()
        mcp = FakeMcp()
        pay = create_paywall(rails=[l402_rail(SECRET, ln.invoice_provider)])
        pay.tool(mcp, "premium", "Premium", {}, premium_handler, price={"amount": 2000})

        class BrokenWallet:
            def pay_invoice(self, bolt11):
                raise RuntimeError("no route")

        buyer = ToolClient([l402_payer(BrokenWallet())], max_total={"sat": 10_000})
        with pytest.raises(PaymentError, match="no route"):
            buyer.call_tool(mcp, "premium")
        assert buyer.spent_for("sat") == 0  # rolled back

    def test_requires_at_least_one_payer(self):
        with pytest.raises(ValueError, match="at least one payer"):
            ToolClient([])

    def test_payer_rejects_an_offer_missing_invoice_or_token(self):
        payer = l402_payer(MockLightning().wallet)
        with pytest.raises(ValueError, match="missing"):
            payer.pay({"scheme": "l402", "amount": 1, "asset": "sat"})

    def test_get_payment_challenge_ignores_non_challenge_results(self):
        assert get_payment_challenge({"content": []}) is None
        assert get_payment_challenge({"content": [], "_meta": {}}) is None
        assert (
            get_payment_challenge({"content": [], "_meta": {"ai.bolthub/payment": {"status": "nope"}}})
            is None
        )
        assert get_payment_challenge(None) is None

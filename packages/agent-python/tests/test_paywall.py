import asyncio

import pytest

from bolthub import (
    PAYMENT_META_KEY,
    SPEC_VERSION,
    create_paywall,
    l402_rail,
    random_preimage,
    sha256_hex,
    verify_l402_token,
)

SECRET = "test-secret-at-least-thirty-two-bytes-long!!"


class MockInvoices:
    """Deterministic invoice provider that remembers each invoice's preimage so
    a test can "pay" by recovering it. Mirrors what a real wallet does internally."""

    def __init__(self):
        self.preimage_by_hash = {}

    def create_invoice(self, amount_sat, memo):
        preimage = random_preimage()
        payment_hash = sha256_hex(preimage)
        self.preimage_by_hash[payment_hash] = preimage
        return f"lnbcmock{amount_sat}_{payment_hash[:8]}", payment_hash


def challenge_of(result):
    return result["_meta"][PAYMENT_META_KEY]


def pay_challenge(challenge, invoices):
    """Recover the L402 proof extra for a challenge from the mock provider."""
    offer = next(o for o in challenge["offers"] if o["scheme"] == "l402")
    token = offer["token"]
    verified = verify_l402_token(SECRET, token)
    assert verified["ok"], "offer token did not verify"
    preimage = invoices.preimage_by_hash[verified["payload"]["paymentHash"]]
    return {"_meta": {PAYMENT_META_KEY: {"scheme": "l402", "proof": f"{token}:{preimage}"}}}


def secret_handler(args, extra):
    return {"content": [{"type": "text", "text": "SECRET DATA"}]}


class TestPaywallL402Rail:
    def test_a_call_with_no_proof_returns_a_payment_required_challenge(self):
        invoices = MockInvoices()
        pay = create_paywall(rails=[l402_rail(SECRET, invoices)])
        handler = pay(secret_handler, price={"amount": 2000}, resource="get_image")

        result = handler({})
        assert result["isError"] is True
        challenge = challenge_of(result)
        assert challenge["status"] == "payment_required"
        assert challenge["version"] == SPEC_VERSION
        assert challenge["price"] == {"amount": 2000, "asset": "sat"}
        assert challenge["resource"] == "get_image"
        assert challenge["offers"][0]["scheme"] == "l402"
        assert "invoice" in challenge["offers"][0]
        # The real handler must NOT have run.
        assert "SECRET DATA" not in result["content"][0]["text"]

    def test_a_valid_proof_unlocks_the_handler_and_fires_on_paid(self):
        invoices = MockInvoices()
        paid = []
        pay = create_paywall(
            rails=[l402_rail(SECRET, invoices)],
            on_paid=lambda info: paid.append(
                {"resource": info["resource"], "scheme": info["scheme"]}
            ),
        )
        handler = pay(secret_handler, price={"amount": 2000}, resource="get_image")

        challenge = challenge_of(handler({}))
        result = handler({}, pay_challenge(challenge, invoices))

        assert "isError" not in result
        assert result["content"][0]["text"] == "SECRET DATA"
        assert paid == [{"resource": "get_image", "scheme": "l402"}]

    def test_an_async_handler_gets_an_async_wrapper(self):
        invoices = MockInvoices()
        pay = create_paywall(rails=[l402_rail(SECRET, invoices)])

        async def handler(args, extra):
            return {"content": [{"type": "text", "text": "ASYNC DATA"}]}

        wrapped = pay(handler, price={"amount": 2000}, resource="get_image")

        challenge = challenge_of(asyncio.run(wrapped({})))
        assert challenge["status"] == "payment_required"
        result = asyncio.run(wrapped({}, pay_challenge(challenge, invoices)))
        assert result["content"][0]["text"] == "ASYNC DATA"

    def test_a_tampered_preimage_is_rejected(self):
        invoices = MockInvoices()
        pay = create_paywall(rails=[l402_rail(SECRET, invoices)])
        handler = pay(secret_handler, price={"amount": 2000}, resource="get_image")

        challenge = challenge_of(handler({}))
        token = challenge["offers"][0]["token"]
        bad_proof = {
            "_meta": {
                PAYMENT_META_KEY: {"scheme": "l402", "proof": f"{token}:{random_preimage()}"}
            }
        }
        result = handler({}, bad_proof)
        assert result["isError"] is True
        assert "preimage does not match" in result["content"][0]["text"]

    def test_a_proof_minted_for_another_resource_cannot_unlock_this_tool(self):
        invoices = MockInvoices()
        pay = create_paywall(rails=[l402_rail(SECRET, invoices)])
        tool_a = pay(
            lambda args, extra: {"content": [{"type": "text", "text": "A"}]},
            price={"amount": 2000},
            resource="tool_a",
        )
        tool_b = pay(
            lambda args, extra: {"content": [{"type": "text", "text": "B"}]},
            price={"amount": 2000},
            resource="tool_b",
        )

        # Pay tool A, then present A's proof to tool B.
        proof_for_a = pay_challenge(challenge_of(tool_a({})), invoices)
        result = tool_b({}, proof_for_a)
        assert result["isError"] is True
        assert "different resource" in result["content"][0]["text"]

    def test_an_unsupported_scheme_is_rejected_with_a_fresh_challenge(self):
        invoices = MockInvoices()
        pay = create_paywall(rails=[l402_rail(SECRET, invoices)])
        handler = pay(secret_handler, price={"amount": 2000}, resource="get_image")

        result = handler(
            {}, {"_meta": {PAYMENT_META_KEY: {"scheme": "bogus", "proof": "0xdeadbeef"}}}
        )
        assert result["isError"] is True
        assert 'Unsupported payment scheme "bogus"' in result["content"][0]["text"]

    def test_the_tool_registrar_defaults_resource_to_the_tool_name(self):
        invoices = MockInvoices()
        pay = create_paywall(rails=[l402_rail(SECRET, invoices)])
        registered = {}

        class FakeServer:
            def tool(self, name, description, schema, handler):
                registered["name"] = name
                registered["handler"] = handler

        pay.tool(
            FakeServer(),
            "weather",
            "Get weather",
            {},
            lambda args, extra: {"content": [{"type": "text", "text": "sunny"}]},
            price={"amount": 10},
        )
        challenge = challenge_of(registered["handler"]({}))
        assert challenge["resource"] == "weather"

    def test_rejects_a_missing_resource_and_a_non_positive_price(self):
        pay = create_paywall(rails=[l402_rail(SECRET, MockInvoices())])
        with pytest.raises(ValueError, match="resource"):
            pay(secret_handler, price={"amount": 10}, resource="")
        with pytest.raises(ValueError, match="positive integer"):
            pay(secret_handler, price={"amount": 0}, resource="x")

    def test_rejects_a_paywall_with_no_rails(self):
        with pytest.raises(ValueError, match="at least one rail"):
            create_paywall(rails=[])

    def test_l402_rail_rejects_a_short_secret(self):
        with pytest.raises(ValueError, match="at least 32 bytes"):
            l402_rail("too-short", MockInvoices())

    def test_advertise_reflects_the_configured_rails_and_price(self):
        pay = create_paywall(rails=[l402_rail(SECRET, MockInvoices())])
        assert pay.advertise({"amount": 2000}) == {
            "version": SPEC_VERSION,
            "price": {"amount": 2000, "asset": "sat"},
            "model": "per_call",
            "rails": ["l402"],
        }

    def test_multi_asset_pricing_offers_one_l402_offer_per_settleable_price(self):
        invoices = MockInvoices()
        pay = create_paywall(rails=[l402_rail(SECRET, invoices)])
        handler = pay(
            lambda args, extra: {"content": [{"type": "text", "text": "MULTI DATA"}]},
            price=[{"amount": 2000, "asset": "sat"}, {"amount": 5000, "asset": "usd"}],
            resource="multi",
        )

        challenge = challenge_of(handler({}))
        # The L402 rail settles only sats, so the usd price is simply not offered.
        assert [o["scheme"] for o in challenge["offers"]] == ["l402"]
        assert challenge["offers"][0]["amount"] == 2000

        result = handler({}, pay_challenge(challenge, invoices))
        assert result["content"][0]["text"] == "MULTI DATA"

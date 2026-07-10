"""on_paid receipt-field enrichment (AF-B2) — parity with @bolthub/pay.

Pins: on_paid payloads carry preimage, invoice, and payment_hash (from the
402 body when present, None otherwise) in addition to the original four
keys, on both the sync and async clients and on both callback levels.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import httpx

from bolthub import AsyncL402Client, L402Client


class MockWallet:
    def __init__(self, preimage="a" * 64):
        self._preimage = preimage
        self.calls = []

    def pay_invoice(self, bolt11: str) -> str:
        self.calls.append(bolt11)
        return self._preimage


def scripted(responses, calls):
    def side_effect(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        return responses[len(calls) - 1]

    return side_effect


def make_402(payment_hash="hash123"):
    body = {"error": "Payment Required", "amountSats": 10}
    if payment_hash is not None:
        body["paymentHash"] = payment_hash
    return httpx.Response(
        status_code=402,
        headers={"WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."'},
        json=body,
    )


def make_200():
    return httpx.Response(status_code=200, json={"ok": True})


class TestSyncReceiptFields:
    def test_client_level_and_per_request_get_receipt_fields(self):
        wallet = MockWallet()
        client_infos, request_infos = [], []
        client = L402Client(wallet, on_paid=client_infos.append)
        calls = []
        with patch.object(
            client._client, "request", side_effect=scripted([make_402(), make_200()], calls)
        ):
            client.request(
                "GET", "https://example.com/api", on_paid=request_infos.append
            )

        assert len(client_infos) == 1 and len(request_infos) == 1
        for info in (client_infos[0], request_infos[0]):
            # Original keys unchanged (non-breaking).
            assert info["scheme"] == "l402"
            assert info["amount"] == 10
            assert info["asset"] == "sat"
            assert info["resource"] == "https://example.com/api"
            # New receipt fields.
            assert info["preimage"] == "a" * 64
            assert info["invoice"] == "lnbc1000..."
            assert info["payment_hash"] == "hash123"

    def test_payment_hash_none_when_body_lacks_it(self):
        wallet = MockWallet()
        infos = []
        client = L402Client(wallet, on_paid=infos.append)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted([make_402(payment_hash=None), make_200()], calls),
        ):
            client.get("https://example.com/api")

        assert infos[0]["payment_hash"] is None
        assert infos[0]["preimage"] == "a" * 64

    def test_old_style_callback_reading_original_keys_still_works(self):
        seen = []
        client = L402Client(
            MockWallet(), on_paid=lambda i: seen.append((i["amount"], i["resource"]))
        )
        calls = []
        with patch.object(
            client._client, "request", side_effect=scripted([make_402(), make_200()], calls)
        ):
            client.get("https://example.com/api")
        assert seen == [(10, "https://example.com/api")]


class TestAsyncReceiptFields:
    def test_async_client_gets_receipt_fields(self):
        async def run():
            infos = []
            client = AsyncL402Client(MockWallet(), on_paid=infos.append)
            calls = []
            responses = [make_402(), make_200()]

            async def side_effect(method, url, **kwargs):
                calls.append(1)
                return responses[len(calls) - 1]

            with patch.object(client._client, "request", side_effect=side_effect):
                await client.request("GET", "https://example.com/api")

            assert infos[0]["preimage"] == "a" * 64
            assert infos[0]["invoice"] == "lnbc1000..."
            assert infos[0]["payment_hash"] == "hash123"

        asyncio.run(run())

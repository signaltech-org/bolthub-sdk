"""Receipt store + client wiring (AF-B3) — parity with @bolthub/pay.

Pins: JSONL file store is 0600 and append-only; payment_hash is filled as
sha256(preimage) when missing; torn lines never break the ledger; a paid
call records exactly one receipt with the gateway outcome; session-reuse
calls record nothing; a throwing store never fails the paid call.
"""

from __future__ import annotations

import hashlib
import json
import stat
from datetime import datetime, timezone
from unittest.mock import patch

import httpx

from bolthub import (
    FileReceiptStore,
    InMemoryReceiptStore,
    L402Client,
    Receipt,
    complete_receipt,
)

PREIMAGE = "ab" * 32
PREIMAGE_HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()


def make_receipt(**overrides) -> Receipt:
    base = dict(
        receipt_v=1,
        ts="2026-07-09T12:00:00+00:00",
        resource="https://acme.gw.bolthub.ai/v1/data",
        method="GET",
        amount_sats=10,
        payment_hash="hash123",
        preimage=PREIMAGE,
        invoice="lnbc1000...",
        outcome="charged",
    )
    base.update(overrides)
    return Receipt(**base)


class TestCompleteReceipt:
    def test_fills_hash_from_preimage(self):
        filled = complete_receipt(make_receipt(payment_hash=""))
        assert filled.payment_hash == PREIMAGE_HASH

    def test_leaves_present_hash(self):
        assert complete_receipt(make_receipt()).payment_hash == "hash123"


class TestFileReceiptStore:
    def test_appends_0600_lists_and_filters(self, tmp_path):
        path = tmp_path / "receipts.jsonl"
        store = FileReceiptStore(path)
        store.append(make_receipt(ts="2026-07-01T00:00:00+00:00"))
        store.append(make_receipt(ts="2026-07-09T00:00:00+00:00", payment_hash=""))

        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert len(path.read_text().strip().splitlines()) == 2

        receipts = store.list()
        assert len(receipts) == 2
        assert receipts[1].payment_hash == PREIMAGE_HASH  # filled on append

        recent = store.list(
            from_ts=datetime(2026, 7, 5, tzinfo=timezone.utc)
        )
        assert [r.ts for r in recent] == ["2026-07-09T00:00:00+00:00"]

    def test_torn_lines_skipped(self, tmp_path):
        path = tmp_path / "receipts.jsonl"
        path.write_text(
            json.dumps(make_receipt().__dict__)
            + "\n{torn json\n"
            + json.dumps(make_receipt(ts="2026-07-10T00:00:00+00:00").__dict__)
            + "\n"
        )
        assert len(FileReceiptStore(path).list()) == 2

    def test_missing_file_lists_empty(self, tmp_path):
        assert FileReceiptStore(tmp_path / "missing.jsonl").list() == []


class TestExportReceipts:
    def test_json_roundtrip_all_fields(self):
        from bolthub import export_receipts

        out = export_receipts([make_receipt()])
        parsed = json.loads(out)
        assert list(parsed[0].keys()) == [
            "receipt_v", "ts", "resource", "method", "amount_sats",
            "payment_hash", "preimage", "invoice", "outcome",
        ]

    def test_csv_column_order_and_quoting(self):
        from bolthub import export_receipts

        out = export_receipts(
            [make_receipt(resource='https://x.test/q?a="b",c')], format="csv"
        )
        header, row = out.strip().splitlines()
        assert header == (
            "receipt_v,ts,resource,method,amount_sats,"
            "payment_hash,preimage,invoice,outcome"
        )
        assert '"https://x.test/q?a=""b"",c"' in row
        assert row.endswith(",charged")

    def test_redact_strips_preimage_only(self):
        from bolthub import export_receipts

        parsed = json.loads(export_receipts([make_receipt()], redact=True))
        assert parsed[0]["preimage"] == "REDACTED"
        assert parsed[0]["payment_hash"] == "hash123"

    def test_client_export_requires_store(self):
        import pytest
        from bolthub import L402Error

        client = L402Client(MockWallet())
        with pytest.raises(L402Error):
            client.export_receipts()

    def test_client_export_serializes_store(self):
        store = InMemoryReceiptStore()
        store.append(make_receipt(ts="2026-07-01T00:00:00+00:00"))
        store.append(make_receipt(ts="2026-07-09T00:00:00+00:00"))
        client = L402Client(MockWallet(), receipt_store=store)

        assert len(json.loads(client.export_receipts())) == 2
        recent = json.loads(
            client.export_receipts(from_ts=datetime(2026, 7, 5, tzinfo=timezone.utc))
        )
        assert len(recent) == 1
        csv_out = client.export_receipts(format="csv", redact=True)
        assert csv_out.startswith("receipt_v,")
        assert "REDACTED" in csv_out


class MockWallet:
    def pay_invoice(self, bolt11: str) -> str:
        return PREIMAGE


def scripted(responses, calls):
    def side_effect(method, url, **kwargs):
        calls.append(1)
        return responses[len(calls) - 1]

    return side_effect


def make_402():
    return httpx.Response(
        status_code=402,
        headers={"WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."'},
        json={"error": "Payment Required", "amountSats": 10, "paymentHash": "hash123"},
    )


class TestClientWiring:
    def test_paid_call_records_one_receipt_with_outcome(self):
        store = InMemoryReceiptStore()
        client = L402Client(MockWallet(), receipt_store=store)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted(
                [
                    make_402(),
                    httpx.Response(
                        status_code=200,
                        headers={"X-Bolthub-Payment": "charged"},
                        json={"ok": True},
                    ),
                ],
                calls,
            ),
        ):
            client.post("https://acme.gw.bolthub.ai/v1/data")

        receipts = store.list()
        assert len(receipts) == 1
        r = receipts[0]
        assert r.method == "POST"
        assert r.amount_sats == 10
        assert r.payment_hash == "hash123"
        assert r.preimage == PREIMAGE
        assert r.invoice == "lnbc1000..."
        assert r.outcome == "charged"

    def test_outcome_unknown_without_header(self):
        store = InMemoryReceiptStore()
        client = L402Client(MockWallet(), receipt_store=store)
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted(
                [make_402(), httpx.Response(status_code=200, json={"ok": True})], calls
            ),
        ):
            client.get("https://acme.gw.bolthub.ai/v1/data")
        assert store.list()[0].outcome == "unknown"

    def test_throwing_store_never_fails_the_call(self):
        class BrokenStore:
            def append(self, receipt):
                raise OSError("disk full")

            def list(self, **kwargs):
                return []

        client = L402Client(MockWallet(), receipt_store=BrokenStore())
        calls = []
        with patch.object(
            client._client,
            "request",
            side_effect=scripted(
                [make_402(), httpx.Response(status_code=200, json={"ok": True})], calls
            ),
        ):
            resp = client.get("https://acme.gw.bolthub.ai/v1/data")
        assert resp.status_code == 200

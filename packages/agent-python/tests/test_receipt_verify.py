"""Offline receipt verification (AF-B6) — parity with @bolthub/pay.

Uses a self-built, checksum-valid bech32 invoice so every rule can be tested
against a payment hash we chose.
"""

from __future__ import annotations

import hashlib

from bolthub import bolt11_payment_hash, verify_receipt
from bolthub.receipt_store import Receipt

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_GENERATOR = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)


def _polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= _GENERATOR[i]
    return chk


def _hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _hex_to_5bit(hex_str):
    acc = 0
    bits = 0
    out = []
    for i in range(0, len(hex_str), 2):
        acc = (acc << 8) | int(hex_str[i : i + 2], 16)
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append((acc >> bits) & 31)
    if bits > 0:
        out.append((acc << (5 - bits)) & 31)
    return out


def build_invoice(hrp: str, payment_hash_hex: str) -> str:
    hash_groups = _hex_to_5bit(payment_hash_hex)
    data = (
        [0] * 7
        + [1, len(hash_groups) // 32, len(hash_groups) % 32]
        + hash_groups
        + [0] * 104
    )
    mod = _polymod(_hrp_expand(hrp) + data + [0] * 6) ^ 1
    checksum = [(mod >> (5 * (5 - p))) & 31 for p in range(6)]
    return hrp + "1" + "".join(_CHARSET[v] for v in data + checksum)


PREIMAGE = "cd" * 32
HASH = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()
INVOICE = build_invoice("lnbc100n", HASH)  # 10 sats


def make_receipt(**overrides) -> Receipt:
    base = dict(
        receipt_v=1,
        ts="2026-07-09T12:00:00+00:00",
        resource="https://acme.gw.bolthub.ai/v1/data",
        method="GET",
        amount_sats=10,
        payment_hash=HASH,
        preimage=PREIMAGE,
        invoice=INVOICE,
        outcome="charged",
    )
    base.update(overrides)
    return Receipt(**base)


def test_extracts_committed_hash():
    assert bolt11_payment_hash(INVOICE) == HASH


def test_corrupted_char_breaks_checksum():
    corrupted = INVOICE[:20] + ("p" if INVOICE[20] == "q" else "q") + INVOICE[21:]
    assert bolt11_payment_hash(corrupted) is None


def test_valid_receipt():
    result = verify_receipt(make_receipt())
    assert result.status == "valid"
    assert result.reasons == []


def test_tampered_preimage_invalid():
    result = verify_receipt(make_receipt(preimage="ee" * 32))
    assert result.status == "invalid"
    assert any("sha256(preimage)" in r for r in result.reasons)


def test_inflated_amount_invalid():
    result = verify_receipt(make_receipt(amount_sats=99))
    assert result.status == "invalid"
    assert any("amount" in r for r in result.reasons)


def test_swapped_invoice_fails_commitment():
    other = build_invoice("lnbc100n", "ab" * 32)
    result = verify_receipt(make_receipt(invoice=other))
    assert result.status == "invalid"
    assert any("committed in the invoice" in r for r in result.reasons)


def test_redacted_and_missing():
    assert verify_receipt(make_receipt(preimage="REDACTED")).status == "redacted"
    assert verify_receipt(make_receipt(invoice="")).status == "unverifiable"

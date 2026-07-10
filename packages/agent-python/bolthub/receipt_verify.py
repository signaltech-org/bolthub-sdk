"""Offline receipt verification (parity with @bolthub/pay's receipt-verify).

SPIKE-8 rules, no bolthub service in the loop:

1. ``sha256(preimage) == payment_hash`` (proof of payment)
2. ``payment_hash`` equals the hash the BOLT11 invoice commits to
3. ``amount_sats`` equals the invoice amount, when the invoice carries one

Statuses: ``valid``, ``redacted`` (stripped by a redacted export — an
expense record, not a proof; by design), ``invalid`` (see reasons),
``unverifiable`` (fields missing). The invoice signature is not checked:
verifying the signer needs network context; the hash commitment doesn't.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from .receipt_store import Receipt

__all__ = ["ReceiptVerifyResult", "verify_receipt", "bolt11_payment_hash"]

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_GENERATOR = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)


def _polymod(values: list[int]) -> int:
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= _GENERATOR[i]
    return chk


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _five_bit_to_hex(groups: list[int], bytes_wanted: int) -> str | None:
    acc = 0
    bits = 0
    out = bytearray()
    for g in groups:
        acc = (acc << 5) | g
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if len(out) < bytes_wanted:
        return None
    return out[:bytes_wanted].hex()


def bolt11_payment_hash(invoice: str) -> str | None:
    """The payment hash a BOLT11 invoice commits to (64 hex chars), or
    ``None`` when the invoice does not parse."""
    if not invoice:
        return None
    s = invoice.strip().lower()
    sep = s.rfind("1")
    if sep <= 0:
        return None
    hrp = s[:sep]
    if not hrp.startswith("ln"):
        return None
    data: list[int] = []
    for ch in s[sep + 1 :]:
        v = _CHARSET.find(ch)
        if v == -1:
            return None
        data.append(v)
    if len(data) < 7 + 104 + 6:
        return None
    if _polymod(_hrp_expand(hrp) + data) != 1:
        return None
    payload = data[:-6]
    end = len(payload) - 104  # 512-bit signature + 8-bit recovery id
    i = 7  # 35-bit timestamp
    while i + 3 <= end:
        ftype = payload[i]
        flen = payload[i + 1] * 32 + payload[i + 2]
        i += 3
        if i + flen > end:
            return None
        if ftype == 1 and flen == 52:
            return _five_bit_to_hex(payload[i : i + flen], 32)
        i += flen
    return None


def _bolt11_amount_sats(invoice: str) -> int | None:
    """Amount from the HRP; mirrors bolthub._engine's decoding rules."""
    import re

    s = invoice.strip().lower()
    sep = s.rfind("1")
    if sep <= 0:
        return None
    m = re.fullmatch(r"ln(?:bcrt|bc|tbs|tb)(\d+)([munp])", s[:sep])
    if not m:
        return None
    per_unit = {"m": 100_000, "u": 100, "n": 0.1, "p": 0.0001}[m.group(2)]
    sats = round(int(m.group(1)) * per_unit)
    return sats if sats > 0 else None


@dataclass(frozen=True)
class ReceiptVerifyResult:
    status: str  # valid | redacted | invalid | unverifiable
    reasons: list[str] = field(default_factory=list)


def verify_receipt(receipt: Receipt) -> ReceiptVerifyResult:
    if receipt.preimage == "REDACTED":
        return ReceiptVerifyResult("redacted", ["preimage redacted by export"])
    if not receipt.preimage or not receipt.payment_hash or not receipt.invoice:
        missing = [
            name
            for name, value in (
                ("preimage", receipt.preimage),
                ("payment_hash", receipt.payment_hash),
                ("invoice", receipt.invoice),
            )
            if not value
        ]
        return ReceiptVerifyResult("unverifiable", [f"missing: {', '.join(missing)}"])

    reasons: list[str] = []
    try:
        preimage_hash = hashlib.sha256(bytes.fromhex(receipt.preimage)).hexdigest()
    except ValueError:
        preimage_hash = None
    if preimage_hash is None:
        reasons.append("preimage is not valid hex")
    elif preimage_hash != receipt.payment_hash.lower():
        reasons.append("sha256(preimage) does not match payment_hash")

    invoice_hash = bolt11_payment_hash(receipt.invoice)
    if invoice_hash is None:
        reasons.append("invoice does not decode (bad bech32 or no payment hash)")
    elif invoice_hash != receipt.payment_hash.lower():
        reasons.append("payment_hash does not match the hash committed in the invoice")

    invoice_amount = _bolt11_amount_sats(receipt.invoice)
    if invoice_amount is not None and invoice_amount != receipt.amount_sats:
        reasons.append(
            f"amount_sats ({receipt.amount_sats}) differs from the invoice amount ({invoice_amount})"
        )

    if reasons:
        return ReceiptVerifyResult("invalid", reasons)
    return ReceiptVerifyResult("valid")

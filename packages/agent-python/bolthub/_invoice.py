"""Dependency-free BOLT11 amount decoding.

Only the human-readable prefix (HRP) of a BOLT11 invoice is parsed to recover
the payable amount. The bech32 data part (which carries payment hash, routing
hints, etc.) is never decoded here, so no external dependency is required.

This is the authoritative price source for an L402 challenge: the invoice is
always present in the ``WWW-Authenticate`` header, and the bolthub gateway's own
end-to-end test asserts the invoice amount equals the body's ``amountSats``
(see ``packages/cli/e2e/paid-call.ts``).

Note on correctness: a naive ``^ln(bc|tb...)(\\d+)([munp])`` regex mis-reads an
*amountless* invoice (``lnbc1p...``) by treating the bech32 separator ``1`` as
an amount digit. We instead split the HRP off at the bech32 separator (the last
``1`` — the bech32 data charset never contains ``1``) and parse the amount from
the HRP alone, which disambiguates amountless invoices to ``None``.
"""

from __future__ import annotations

import re
from decimal import Decimal, ROUND_HALF_UP

# Currency prefixes, longest-first so the alternation is unambiguous:
# bcrt (regtest), bc (mainnet), tbs (signet), tb (testnet).
_HRP_RE = re.compile(r"^ln(?:bcrt|bc|tbs|tb)(\d+)([munp])$")

# sats = digits * multiplier_in_btc * 1e8.
#   m (milli, 1e-3) -> * 1e5
#   u (micro, 1e-6) -> * 1e2
#   n (nano,  1e-9) -> / 10
#   p (pico,  1e-12)-> / 10_000
_SATS_PER_UNIT = {
    "m": Decimal(100_000),
    "u": Decimal(100),
    "n": Decimal(1) / Decimal(10),
    "p": Decimal(1) / Decimal(10_000),
}


def bolt11_amount_sats(invoice: str) -> int | None:
    """Decode the amount in satoshis from a BOLT11 invoice's HRP.

    Returns ``None`` for amountless invoices, multiplier-less (whole-BTC)
    amounts, or anything that does not parse. Sub-satoshi amounts (``p``
    multiplier) are rounded to the nearest satoshi.
    """
    if not invoice:
        return None
    s = invoice.strip().lower()
    # The bech32 separator is the last '1'; bech32 data never contains '1'.
    if "1" not in s:
        return None
    hrp = s.rsplit("1", 1)[0]
    m = _HRP_RE.match(hrp)
    if not m:
        return None
    digits, unit = m.group(1), m.group(2)
    sats = Decimal(digits) * _SATS_PER_UNIT[unit]
    value = int(sats.to_integral_value(rounding=ROUND_HALF_UP))
    return value if value > 0 else None

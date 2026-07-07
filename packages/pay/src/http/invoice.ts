/**
 * Dependency-free BOLT11 amount decoding.
 *
 * Only the human-readable prefix (HRP) of a BOLT11 invoice is parsed to recover
 * the payable amount. The bech32 data part is never decoded, so no dependency
 * is required. The invoice is the authoritative price source for an L402
 * challenge: it is always present in the `WWW-Authenticate` header, and the
 * gateway's own e2e asserts the invoice amount equals the body's `amountSats`.
 *
 * The HRP is split off at the bech32 separator (the last `1`; bech32 data never
 * contains `1`) so an amountless invoice (`lnbc1p...`) resolves to `null` rather
 * than mis-reading the separator as an amount.
 */

// Currency prefixes, longest-first: bcrt (regtest), bc (mainnet), tbs (signet), tb (testnet).
const HRP_RE = /^ln(?:bcrt|bc|tbs|tb)(\d+)([munp])$/;

// sats = digits * multiplier_in_btc * 1e8.
const SATS_PER_UNIT: Record<string, number> = {
  m: 100_000, // milli (1e-3)
  u: 100, // micro (1e-6)
  n: 0.1, // nano  (1e-9)
  p: 0.0001, // pico  (1e-12)
};

/**
 * Decode the amount in satoshis from a BOLT11 invoice's HRP. Returns `null` for
 * amountless invoices, multiplier-less amounts, or anything that does not parse.
 * Sub-satoshi amounts are rounded to the nearest satoshi.
 */
export function bolt11AmountSats(invoice: string): number | null {
  if (!invoice) return null;
  const s = invoice.trim().toLowerCase();
  // The bech32 separator is the last `1`; the HRP is everything before it.
  const sep = s.lastIndexOf("1");
  if (sep <= 0) return null;
  const hrp = s.slice(0, sep);
  const m = HRP_RE.exec(hrp);
  if (!m) return null;
  const sats = Math.round(Number(m[1]) * SATS_PER_UNIT[m[2]]);
  return sats > 0 ? sats : null;
}

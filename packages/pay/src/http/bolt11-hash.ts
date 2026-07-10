/**
 * Dependency-free BOLT11 payment-hash extraction (companion to invoice.ts,
 * which only reads the HRP amount).
 *
 * Decodes the bech32 data part (checksum-verified), skips the 35-bit
 * timestamp, and walks the tagged fields to the `p` field (type 1, 52
 * five-bit groups = the 256-bit payment hash). The signature (last 104
 * groups) is NOT verified — receipt verification only needs the hash the
 * invoice commits to, and verifying the signer requires network context.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod(hrpExpand(hrp).concat(data)) === 1;
}

function fiveBitToHex(groups: number[], bytesWanted: number): string | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const g of groups) {
    acc = (acc << 5) | g;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length < bytesWanted) return null;
  return out
    .slice(0, bytesWanted)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The payment hash a BOLT11 invoice commits to, as 64 hex chars, or `null`
 * when the invoice does not parse (bad bech32, bad checksum, no `p` field).
 */
export function bolt11PaymentHash(invoice: string): string | null {
  if (!invoice) return null;
  const s = invoice.trim().toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep <= 0) return null;
  const hrp = s.slice(0, sep);
  if (!hrp.startsWith("ln")) return null;

  const data: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  // 7 groups timestamp + 104 groups signature + 6 groups checksum, minimum.
  if (data.length < 7 + 104 + 6) return null;
  if (!verifyChecksum(hrp, data)) return null;

  const payload = data.slice(0, -6);
  const end = payload.length - 104; // signature: 512-bit sig + 8-bit recovery id
  let i = 7; // timestamp
  while (i + 3 <= end) {
    const type = payload[i];
    const len = payload[i + 1] * 32 + payload[i + 2];
    i += 3;
    if (i + len > end) return null;
    if (type === 1 && len === 52) {
      return fiveBitToHex(payload.slice(i, i + len), 32);
    }
    i += len;
  }
  return null;
}

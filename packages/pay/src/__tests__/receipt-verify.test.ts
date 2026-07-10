import { describe, test, expect } from "bun:test";
import { createHash } from "crypto";
import { verifyReceipt } from "../http/receipt-verify";
import { bolt11PaymentHash } from "../http/bolt11-hash";
import type { Receipt } from "../http/receipt-store";

// ── Minimal bech32 encoder to build self-consistent test invoices ──────────
// (mirrors the decoder's constants; a receipt verifier must be tested against
// invoices whose payment hash WE chose, which no public test vector allows).

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GENERATOR[i];
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

function hexTo5Bit(hex: string): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/** Build a checksum-valid BOLT11-shaped invoice committing to paymentHash. */
function buildInvoice(hrp: string, paymentHashHex: string): string {
  const timestamp = [0, 0, 0, 0, 0, 0, 0];
  const hashGroups = hexTo5Bit(paymentHashHex); // 32 bytes -> 52 groups
  const tagged = [1, Math.floor(hashGroups.length / 32), hashGroups.length % 32, ...hashGroups];
  const signature = new Array(104).fill(0);
  const data = [...timestamp, ...tagged, ...signature];
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let p = 0; p < 6; p++) checksum.push((mod >> (5 * (5 - p))) & 31);
  return hrp + "1" + [...data, ...checksum].map((v) => CHARSET[v]).join("");
}

const PREIMAGE = "cd".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
// lnbc100n = 10 sats.
const INVOICE = buildInvoice("lnbc100n", HASH);

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_v: 1,
    ts: "2026-07-09T12:00:00.000Z",
    resource: "https://acme.gw.bolthub.ai/v1/data",
    method: "GET",
    amount_sats: 10,
    payment_hash: HASH,
    preimage: PREIMAGE,
    invoice: INVOICE,
    outcome: "charged",
    ...overrides,
  };
}

describe("bolt11PaymentHash", () => {
  test("extracts the committed hash from a checksum-valid invoice", () => {
    expect(bolt11PaymentHash(INVOICE)).toBe(HASH);
  });

  test("a corrupted character breaks the checksum and yields null", () => {
    const corrupted = INVOICE.slice(0, 20) + (INVOICE[20] === "q" ? "p" : "q") + INVOICE.slice(21);
    expect(bolt11PaymentHash(corrupted)).toBeNull();
  });

  test("garbage yields null", () => {
    expect(bolt11PaymentHash("not an invoice")).toBeNull();
    expect(bolt11PaymentHash("")).toBeNull();
  });
});

describe("verifyReceipt", () => {
  test("a genuine receipt is valid", () => {
    expect(verifyReceipt(makeReceipt())).toEqual({ status: "valid", reasons: [] });
  });

  test("tampered preimage fails the sha256 check", () => {
    const result = verifyReceipt(makeReceipt({ preimage: "ee".repeat(32) }));
    expect(result.status).toBe("invalid");
    expect(result.reasons.join()).toContain("sha256(preimage)");
  });

  test("swapped payment_hash fails both hash checks", () => {
    const result = verifyReceipt(makeReceipt({ payment_hash: "ff".repeat(32) }));
    expect(result.status).toBe("invalid");
    expect(result.reasons).toHaveLength(2);
  });

  test("inflated amount fails the amount check", () => {
    const result = verifyReceipt(makeReceipt({ amount_sats: 99 }));
    expect(result.status).toBe("invalid");
    expect(result.reasons.join()).toContain("amount");
  });

  test("swapped invoice (right format, different hash) fails the commitment check", () => {
    const otherInvoice = buildInvoice("lnbc100n", "ab".repeat(32));
    const result = verifyReceipt(makeReceipt({ invoice: otherInvoice }));
    expect(result.status).toBe("invalid");
    expect(result.reasons.join()).toContain("committed in the invoice");
  });

  test("redacted receipts report redacted, not invalid", () => {
    expect(verifyReceipt(makeReceipt({ preimage: "REDACTED" })).status).toBe("redacted");
  });

  test("missing fields report unverifiable", () => {
    const result = verifyReceipt(makeReceipt({ invoice: "" }));
    expect(result.status).toBe("unverifiable");
    expect(result.reasons.join()).toContain("invoice");
  });

  test("undecodable invoice is invalid with a decode reason", () => {
    const result = verifyReceipt(makeReceipt({ invoice: "lnbc100n1garbage" }));
    expect(result.status).toBe("invalid");
    expect(result.reasons.join()).toContain("does not decode");
  });

  // Proof boundary, pinned deliberately: receipts prove the PAYMENT
  // (preimage, hash, invoice, amount). Context fields (ts, resource,
  // method, outcome) are self-reported and NOT cryptographically bound —
  // mutating them cannot fail verification. Documented in the receipts
  // guide; anyone needing bound context needs a signed-receipt protocol
  // (declined, see docs/BACKLOG.md).
  test("context fields are self-reported: mutating them stays valid", () => {
    for (const mutation of [
      { resource: "https://evil.example/other" },
      { method: "DELETE" },
      { ts: "2020-01-01T00:00:00.000Z" },
      { outcome: "reverted" },
    ] as Partial<Receipt>[]) {
      expect(verifyReceipt(makeReceipt(mutation)).status).toBe("valid");
    }
  });
});

describe("end to end: paid call -> recorded receipt -> verifies", () => {
  test("the receipt written by L402Client passes offline verification", async () => {
    const { L402Client } = await import("../http/client");
    const { InMemoryReceiptStore } = await import("../http/receipt-store");

    const store = new InMemoryReceiptStore();
    const client = new L402Client({
      wallet: { payInvoice: async () => ({ preimage: PREIMAGE }) },
      receiptStore: store,
    });

    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: "Payment Required", amountSats: 10, paymentHash: HASH }),
          {
            status: 402,
            headers: { "WWW-Authenticate": `L402 macaroon="mac123", invoice="${INVOICE}"` },
          },
        );
      }
      return new Response("{}", { status: 200, headers: { "X-Bolthub-Payment": "charged" } });
    }) as any;

    try {
      await client.get("https://acme.gw.bolthub.ai/v1/data");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const receipts = store.list();
    expect(receipts).toHaveLength(1);
    expect(verifyReceipt(receipts[0])).toEqual({ status: "valid", reasons: [] });
    expect(receipts[0].outcome).toBe("charged");
  });
});

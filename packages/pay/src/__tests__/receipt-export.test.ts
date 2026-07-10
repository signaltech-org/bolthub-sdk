import { describe, test, expect } from "bun:test";
import { exportReceipts } from "../http/receipt-export";
import { InMemoryReceiptStore, type Receipt } from "../http/receipt-store";
import { L402Client, L402Error } from "../http/client";
import type { WalletAdapter } from "../http/types";

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_v: 1,
    ts: "2026-07-09T12:00:00.000Z",
    resource: "https://acme.gw.bolthub.ai/v1/data",
    method: "GET",
    amount_sats: 10,
    payment_hash: "hash123",
    preimage: "ab".repeat(32),
    invoice: "lnbc1000...",
    outcome: "charged",
    ...overrides,
  };
}

describe("exportReceipts", () => {
  test("json is a parseable array with all nine fields", () => {
    const out = exportReceipts([makeReceipt()]);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0])).toEqual([
      "receipt_v", "ts", "resource", "method", "amount_sats",
      "payment_hash", "preimage", "invoice", "outcome",
    ]);
  });

  test("csv uses the schema column order and quotes per RFC 4180", () => {
    const out = exportReceipts(
      [makeReceipt({ resource: 'https://x.test/q?a="b",c' })],
      { format: "csv" },
    );
    const [header, row] = out.trim().split("\n");
    expect(header).toBe(
      "receipt_v,ts,resource,method,amount_sats,payment_hash,preimage,invoice,outcome",
    );
    expect(row).toContain('"https://x.test/q?a=""b"",c"');
    expect(row.endsWith(",charged")).toBe(true);
  });

  test("redact replaces preimages in both formats, leaving the rest intact", () => {
    const json = JSON.parse(exportReceipts([makeReceipt()], { redact: true }));
    expect(json[0].preimage).toBe("REDACTED");
    expect(json[0].payment_hash).toBe("hash123");

    const csv = exportReceipts([makeReceipt()], { format: "csv", redact: true });
    expect(csv).toContain("REDACTED");
    expect(csv).not.toContain("ab".repeat(32));
  });
});

describe("L402Client.exportReceipts", () => {
  const wallet: WalletAdapter = { payInvoice: async () => ({ preimage: "aa" }) };

  test("serializes the configured store with range filtering", () => {
    const store = new InMemoryReceiptStore();
    store.append(makeReceipt({ ts: "2026-07-01T00:00:00.000Z" }));
    store.append(makeReceipt({ ts: "2026-07-09T00:00:00.000Z" }));
    const client = new L402Client({ wallet, receiptStore: store });

    const all = JSON.parse(client.exportReceipts());
    expect(all).toHaveLength(2);

    const recent = JSON.parse(
      client.exportReceipts({ from: new Date("2026-07-05T00:00:00Z") }),
    );
    expect(recent).toHaveLength(1);

    const csv = client.exportReceipts({ format: "csv", redact: true });
    expect(csv.startsWith("receipt_v,")).toBe(true);
    expect(csv).toContain("REDACTED");
  });

  test("throws L402Error without a configured store", () => {
    const client = new L402Client({ wallet });
    expect(() => client.exportReceipts()).toThrow(L402Error);
  });
});

import { describe, test, expect, mock, afterEach } from "bun:test";
import { statSync, readFileSync, writeFileSync, mkdtempSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { L402Client } from "../http/client";
import {
  FileReceiptStore,
  InMemoryReceiptStore,
  completeReceipt,
  type Receipt,
} from "../http/receipt-store";
import type { WalletAdapter } from "../http/types";

const PREIMAGE = "ab".repeat(32);
const PREIMAGE_HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_v: 1,
    ts: "2026-07-09T12:00:00.000Z",
    resource: "https://acme.gw.bolthub.ai/v1/data",
    method: "GET",
    amount_sats: 10,
    payment_hash: "hash123",
    preimage: PREIMAGE,
    invoice: "lnbc1000...",
    outcome: "charged",
    ...overrides,
  };
}

describe("completeReceipt", () => {
  test("fills payment_hash as sha256(preimage) when empty", () => {
    const filled = completeReceipt(makeReceipt({ payment_hash: "" }));
    expect(filled.payment_hash).toBe(PREIMAGE_HASH);
  });

  test("leaves a present payment_hash untouched", () => {
    expect(completeReceipt(makeReceipt()).payment_hash).toBe("hash123");
  });
});

describe("FileReceiptStore", () => {
  test("appends JSONL with 0600, lists back, filters by range", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipts-"));
    const path = join(dir, "receipts.jsonl");
    const store = new FileReceiptStore(path);

    store.append(makeReceipt({ ts: "2026-07-01T00:00:00.000Z" }));
    store.append(makeReceipt({ ts: "2026-07-09T00:00:00.000Z", payment_hash: "" }));

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(path, "utf-8").trim().split("\n")).toHaveLength(2);

    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all[1].payment_hash).toBe(PREIMAGE_HASH); // filled on append

    const july9 = store.list({ from: new Date("2026-07-05T00:00:00Z") });
    expect(july9).toHaveLength(1);
    expect(july9[0].ts).toBe("2026-07-09T00:00:00.000Z");
  });

  test("torn or foreign lines are skipped, not fatal", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipts-"));
    const path = join(dir, "receipts.jsonl");
    writeFileSync(path, JSON.stringify(makeReceipt()) + "\n", { mode: 0o600 });
    appendFileSync(path, "{torn json\n");
    appendFileSync(path, JSON.stringify(makeReceipt({ ts: "2026-07-10T00:00:00.000Z" })) + "\n");

    const store = new FileReceiptStore(path);
    expect(store.list()).toHaveLength(2);
  });

  test("missing file lists empty", () => {
    const store = new FileReceiptStore(join(tmpdir(), "nope", "missing.jsonl"));
    expect(store.list()).toEqual([]);
  });
});

// ── Client wiring ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responses: Response[]) {
  let i = 0;
  globalThis.fetch = mock(async () => responses[i++] ?? new Response("nf", { status: 404 })) as any;
}

function wallet(): WalletAdapter {
  return { payInvoice: mock(async () => ({ preimage: PREIMAGE })) };
}

function challenge(): Response {
  return new Response(
    JSON.stringify({ error: "Payment Required", amountSats: 10, paymentHash: "hash123" }),
    {
      status: 402,
      headers: { "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."' },
    },
  );
}

describe("L402Client receipt recording", () => {
  test("a paid call writes exactly one receipt with the gateway outcome", async () => {
    const store = new InMemoryReceiptStore();
    const client = new L402Client({ wallet: wallet(), receiptStore: store });

    mockFetch([
      challenge(),
      new Response("{}", { status: 200, headers: { "X-Bolthub-Payment": "charged" } }),
    ]);

    await client.post("https://acme.gw.bolthub.ai/v1/data");
    const receipts = store.list();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      receipt_v: 1,
      resource: "https://acme.gw.bolthub.ai/v1/data",
      method: "POST",
      amount_sats: 10,
      payment_hash: "hash123",
      preimage: PREIMAGE,
      invoice: "lnbc1000...",
      outcome: "charged",
    });
  });

  test("outcome is 'unknown' when the gateway emits no header", async () => {
    const store = new InMemoryReceiptStore();
    const client = new L402Client({ wallet: wallet(), receiptStore: store });

    mockFetch([challenge(), new Response("{}", { status: 200 })]);

    await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(store.list()[0].outcome).toBe("unknown");
  });

  test("session-reuse calls add no receipt (no payment happened)", async () => {
    const store = new InMemoryReceiptStore();
    const client = new L402Client({ wallet: wallet(), receiptStore: store });

    mockFetch([
      challenge(),
      new Response("{}", {
        status: 200,
        headers: {
          "X-Session-Token": "sess-1",
          "X-Session-Expires": new Date(Date.now() + 3600_000).toISOString(),
          "X-Session-Balance": "90",
        },
      }),
      new Response("{}", { status: 200, headers: { "X-Session-Token": "sess-1", "X-Session-Balance": "80" } }),
    ]);

    await client.get("https://acme.gw.bolthub.ai/v1/data");
    await client.get("https://acme.gw.bolthub.ai/v1/data"); // rides the session
    expect(store.list()).toHaveLength(1);
  });

  test("no store configured: nothing recorded, request unaffected", async () => {
    const client = new L402Client({ wallet: wallet() });
    mockFetch([challenge(), new Response("{}", { status: 200 })]);
    const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
  });

  test("a throwing store logs a warning but the paid call still succeeds", async () => {
    const store = {
      append: () => {
        throw new Error("disk full");
      },
      list: () => [],
    };
    const client = new L402Client({ wallet: wallet(), receiptStore: store });
    mockFetch([challenge(), new Response("{}", { status: 200 })]);
    const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
  });
});

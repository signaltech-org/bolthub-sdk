import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client } from "../http/client";
import type { WalletAdapter, PaidInfo } from "../http/types";

// onPaid receipt-field enrichment (AF-B2): payloads carry preimage, invoice,
// and paymentHash (from the 402 body when present) in addition to the
// original four fields, on both callback levels. Additive and non-breaking.

const originalFetch = globalThis.fetch;

function mockFetch(responses: Response[]) {
  let callIndex = 0;
  globalThis.fetch = mock(async () => {
    return responses[callIndex++] ?? new Response("Not found", { status: 404 });
  }) as any;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wallet(preimage = "a".repeat(64)): WalletAdapter {
  return { payInvoice: mock(async () => ({ preimage })) };
}

function challenge(paymentHash: string | null = "hash123"): Response {
  const body: Record<string, unknown> = { error: "Payment Required", amountSats: 10 };
  if (paymentHash !== null) body.paymentHash = paymentHash;
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."' },
  });
}

describe("onPaid receipt fields", () => {
  test("client-level and per-request callbacks receive preimage, invoice, paymentHash", async () => {
    const clientInfos: PaidInfo[] = [];
    const requestInfos: PaidInfo[] = [];
    const client = new L402Client({ wallet: wallet(), onPaid: (i) => clientInfos.push(i) });

    mockFetch([challenge(), new Response(JSON.stringify({ ok: true }), { status: 200 })]);

    await client.get("https://example.com/api", { onPaid: (i) => requestInfos.push(i) });

    expect(clientInfos).toHaveLength(1);
    expect(requestInfos).toHaveLength(1);
    for (const info of [clientInfos[0], requestInfos[0]]) {
      // Original fields unchanged (non-breaking).
      expect(info.scheme).toBe("l402");
      expect(info.amount).toBe(10);
      expect(info.asset).toBe("sat");
      expect(info.resource).toBe("https://example.com/api");
      // Receipt fields.
      expect(info.preimage).toBe("a".repeat(64));
      expect(info.invoice).toBe("lnbc1000...");
      expect(info.paymentHash).toBe("hash123");
    }
  });

  test("paymentHash undefined when the 402 body lacks it", async () => {
    const infos: PaidInfo[] = [];
    const client = new L402Client({ wallet: wallet(), onPaid: (i) => infos.push(i) });

    mockFetch([challenge(null), new Response("{}", { status: 200 })]);

    await client.get("https://example.com/api");
    expect(infos[0].paymentHash).toBeUndefined();
    expect(infos[0].preimage).toBe("a".repeat(64));
    expect(infos[0].invoice).toBe("lnbc1000...");
  });

  test("old-style callback reading only amount/resource keeps working", async () => {
    const seen: Array<[number, string]> = [];
    const client = new L402Client({
      wallet: wallet(),
      onPaid: (i) => seen.push([i.amount, i.resource]),
    });

    mockFetch([challenge(), new Response("{}", { status: 200 })]);

    await client.get("https://example.com/api");
    expect(seen).toEqual([[10, "https://example.com/api"]]);
  });
});

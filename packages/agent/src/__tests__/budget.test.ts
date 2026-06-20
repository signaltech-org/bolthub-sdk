import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client, L402BudgetError } from "../client";
import type { WalletAdapter } from "../types";

function createMockWallet(preimage = "pre"): WalletAdapter {
  return { payInvoice: mock(async () => ({ preimage })) };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PRICELESS_INVOICE = "lnbcplaceholder"; // not decodable

function challenge402(opts: { amountSats?: number; invoice?: string; headers?: Record<string, string> } = {}) {
  const body: Record<string, unknown> = { error: "Payment Required" };
  if (opts.amountSats !== undefined) body.amountSats = opts.amountSats;
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "WWW-Authenticate": `L402 macaroon="mac", invoice="${opts.invoice ?? PRICELESS_INVOICE}"`,
      ...(opts.headers ?? {}),
    },
  });
}

function mockFetchSeq(responses: Response[]) {
  let i = 0;
  globalThis.fetch = mock(async () => responses[i++] ?? new Response("nope", { status: 500 })) as any;
}

/** A gateway mock: 200 once an L402 Authorization header is present, else a 402. */
function mockGateway(opts: { amountSats?: number; invoice?: string } = {}) {
  globalThis.fetch = mock(async (_url: string, init?: any) => {
    const headers = new Headers(init?.headers);
    if ((headers.get("authorization") ?? "").startsWith("L402 ")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return challenge402(opts);
  }) as any;
}

describe("unknown-amount policy (P1)", () => {
  test("priceless 402 with no maxPerRequest refuses by default", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet }); // default onUnknownAmount="cap"
    mockFetchSeq([challenge402()]);
    await expect(client.get("https://example.com/api")).rejects.toBeInstanceOf(L402BudgetError);
    expect(wallet.payInvoice).not.toHaveBeenCalled();
    expect(client.totalSpent).toBe(0);
  });

  test("priceless 402 with maxPerRequestSats pays the cap", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, maxPerRequestSats: 200 });
    mockFetchSeq([challenge402(), new Response("{}", { status: 200 })]);
    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(wallet.payInvoice).toHaveBeenCalledWith(PRICELESS_INVOICE);
    expect(client.totalSpent).toBe(200);
  });

  test('onUnknownAmount="refuse" refuses even with a cap set', async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, maxPerRequestSats: 200, onUnknownAmount: "refuse" });
    mockFetchSeq([challenge402()]);
    await expect(client.get("https://example.com/api")).rejects.toBeInstanceOf(L402BudgetError);
    expect(wallet.payInvoice).not.toHaveBeenCalled();
  });

  test('onUnknownAmount="allow" pays uncounted', async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, onUnknownAmount: "allow" });
    mockFetchSeq([challenge402(), new Response("{}", { status: 200 })]);
    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(wallet.payInvoice).toHaveBeenCalled();
    expect(client.totalSpent).toBe(0);
  });

  test("decodes the amount from the invoice when the body is silent", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, budgetSats: 1000 });
    // lnbc2500u -> 250_000 sats, far over budget -> refuse before paying.
    mockFetchSeq([challenge402({ invoice: "lnbc2500u1pdata" })]);
    await expect(client.get("https://example.com/api")).rejects.toThrow("total budget");
    expect(wallet.payInvoice).not.toHaveBeenCalled();
  });

  test("reads the price from priceHeader when body + invoice are silent", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, budgetSats: 10, priceHeader: "X-Price-Sats" });
    mockFetchSeq([challenge402({ headers: { "X-Price-Sats": "50" } })]);
    await expect(client.get("https://example.com/api")).rejects.toThrow("total budget");
    expect(wallet.payInvoice).not.toHaveBeenCalled();
  });
});

describe("payment-failure rollback", () => {
  test("a failed payment is not counted against the budget", async () => {
    const wallet: WalletAdapter = {
      payInvoice: mock(async () => {
        throw new Error("pay failed");
      }),
    };
    const client = new L402Client({ wallet, budgetSats: 1000, payRetries: 0 });
    mockFetchSeq([challenge402({ amountSats: 100 })]);
    await expect(client.get("https://example.com/api")).rejects.toThrow();
    expect(client.totalSpent).toBe(0); // reservation rolled back
  });
});

describe("concurrency (P2)", () => {
  test("concurrent requests never exceed the budget", async () => {
    const wallet = createMockWallet();
    const budget = 20;
    const n = 50;
    const client = new L402Client({ wallet, budgetSats: budget });
    mockGateway({ amountSats: 1 }); // each call costs 1 sat

    const results = await Promise.allSettled(
      Array.from({ length: n }, () => client.get("https://example.com/api")),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof L402BudgetError,
    ).length;

    expect(ok).toBe(budget); // exactly budget requests succeed
    expect(refused).toBe(n - budget);
    expect(client.totalSpent).toBe(budget); // exact, never over
    expect(client.remainingBudget).toBe(0);
  });
});

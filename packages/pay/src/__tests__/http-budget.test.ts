import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client, L402BudgetError } from "../http/client";
import type { WalletAdapter } from "../http/types";

function createMockWallet(preimage = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"): WalletAdapter {
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

  test("a success-shaped payment without a valid preimage rolls back, not counts", async () => {
    // LND reports failures in-band (HTTP 200 + no preimage) and some NWC
    // wallets resolve self-payment rejections the same way. The client must
    // treat that as a failed payment: budget rolled back, cause surfaced.
    const wallet: WalletAdapter = {
      payInvoice: mock(async () => ({ preimage: undefined as unknown as string })),
    };
    const client = new L402Client({ wallet, budgetSats: 1000, payRetries: 0 });
    mockFetchSeq([challenge402({ amountSats: 100 })]);
    await expect(client.get("https://example.com/api")).rejects.toThrow(
      "no valid payment preimage",
    );
    expect(client.totalSpent).toBe(0);
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

describe("describePaymentFailure (M5 payer-error translation)", () => {
  test("routing failures get the no-inbound-liquidity reading", async () => {
    const { describePaymentFailure } = await import("../http/client");
    const msg = describePaymentFailure(new Error("unknown destination node 030586cf"));
    expect(msg).toContain("unknown destination node 030586cf"); // raw preserved
    expect(msg).toContain("no channels or no inbound liquidity");
  });

  test("self-payment failures name the same-wallet cause", async () => {
    const { describePaymentFailure } = await import("../http/client");
    expect(describePaymentFailure(new Error("self-payments not allowed"))).toContain(
      "same wallet",
    );
  });

  test("unrecognized errors pass through untouched", async () => {
    const { describePaymentFailure } = await import("../http/client");
    expect(describePaymentFailure(new Error("weird wallet noise"))).toBe("weird wallet noise");
  });

  // F11 (2026-07-25 smoke): NWC wallets return generic messages where only
  // the NIP-47 code carries the cause — the code must be classified and
  // quoted, never dropped.
  const nip47 = (message: string, code: string) => {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
  };

  test("NIP-47 codes are quoted and classified even when the message is generic", async () => {
    const { describePaymentFailure } = await import("../http/client");
    const cases: Array<[string, string]> = [
      ["INSUFFICIENT_BALANCE", "enough balance"],
      ["RESTRICTED", "pay_invoice permission"],
      ["UNAUTHORIZED", "revoked"],
      ["QUOTA_EXCEEDED", "spending budget"],
      ["RATE_LIMITED", "rate-limiting"],
      ["NOT_IMPLEMENTED", "not implemented"],
      ["PAYMENT_FAILED", "outbound channel liquidity"],
    ];
    for (const [code, expected] of cases) {
      const msg = describePaymentFailure(nip47("Problem sending payment", code));
      expect(msg).toContain("Problem sending payment"); // raw preserved
      expect(msg).toContain(`[wallet error code: ${code}]`); // code quoted
      expect(msg.toLowerCase()).toContain(expected.toLowerCase());
    }
  });

  test("INTERNAL/OTHER still quote the code and point at the payer-side checks", async () => {
    const { describePaymentFailure } = await import("../http/client");
    const msg = describePaymentFailure(nip47("Problem sending payment", "INTERNAL"));
    expect(msg).toContain("[wallet error code: INTERNAL]");
    expect(msg).toContain("balance");
    expect(msg).toContain("liquidity");
  });

  test("relay timeouts read as wallet-unreachable", async () => {
    const { describePaymentFailure } = await import("../http/client");
    const msg = describePaymentFailure(nip47("reply timeout: event abc123", "INTERNAL"));
    expect(msg).toContain("did not respond");
  });

  test("ToolClient wraps payer failures through the same translation", async () => {
    const { ToolClient, l402Payer, PaymentError } = await import("../index");
    const wallet = {
      payInvoice: async () => {
        throw nip47("Problem sending payment", "RESTRICTED");
      },
    };
    const client = new ToolClient({ payers: [l402Payer({ wallet })] });
    const offerResult = {
      isError: true,
      content: [],
      _meta: {
        "ai.bolthub/payment": {
          status: "payment_required",
          version: "1",
          price: { amount: 5, asset: "sat" },
          resource: { uri: "tool:demo" },
          offers: [{ scheme: "l402", amount: 5, asset: "sat", invoice: "lnbcmock5", token: "tok" }],
          expiresAt: Date.now() + 60_000,
        },
      },
    };
    const caller = async (meta?: Record<string, unknown>) =>
      meta ? { content: [{ type: "text", text: "paid" }] } : (offerResult as never);
    await expect(client.call(caller)).rejects.toThrow(PaymentError);
    try {
      await client.call(caller);
      throw new Error("expected client.call to reject");
    } catch (err) {
      expect((err as Error).message).toContain("[wallet error code: RESTRICTED]");
      expect((err as Error).message).toContain("pay_invoice permission");
    }
  });
});

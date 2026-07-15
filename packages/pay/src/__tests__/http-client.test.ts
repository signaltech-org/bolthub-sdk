import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { L402Client, L402BudgetError, L402Error } from "../http/client";
import type { WalletAdapter } from "../http/types";

function createMockWallet(preimage = "a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1"): WalletAdapter {
  return {
    payInvoice: mock(async () => ({ preimage })),
  };
}

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

describe("L402Client", () => {
  test("returns response directly if not 402", () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet });

    mockFetch([new Response(JSON.stringify({ ok: true }), { status: 200 })]);

    return client.get("https://example.com/api").then((resp) => {
      expect(resp.status).toBe(200);
      expect(wallet.payInvoice).not.toHaveBeenCalled();
    });
  });

  test("handles 402 challenge, pays invoice, retries", async () => {
    const wallet = createMockWallet("ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12");
    const client = new L402Client({ wallet });

    const challengeResponse = new Response(
      JSON.stringify({ error: "Payment Required", amountSats: 10 }),
      {
        status: 402,
        headers: {
          "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."',
        },
      },
    );
    const successResponse = new Response(JSON.stringify({ data: "hello" }), { status: 200 });

    mockFetch([challengeResponse, successResponse]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(wallet.payInvoice).toHaveBeenCalledWith("lnbc1000...");
  });

  test("throws L402Error if 402 without WWW-Authenticate", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet });

    mockFetch([new Response("", { status: 402 })]);

    try {
      await client.get("https://example.com/api");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(L402Error);
    }
  });

  test("tracks spent sats", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, budgetSats: 1000 });

    expect(client.totalSpent).toBe(0);
    expect(client.remainingBudget).toBe(1000);
  });

  test("appends query params", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet });

    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as any;

    await client.get("https://example.com/api", { params: { city: "berlin" } });
    expect(capturedUrl).toBe("https://example.com/api?city=berlin");
  });

  test("supports POST method", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet });

    let capturedMethod = "";
    globalThis.fetch = mock(async (_url: string, init: any) => {
      capturedMethod = init?.method ?? "GET";
      return new Response("{}", { status: 200 });
    }) as any;

    await client.post("https://example.com/api", {
      body: JSON.stringify({ data: true }),
    });
    expect(capturedMethod).toBe("POST");
  });

  test("extractAmount parses amountSats from 402 body and tracks spending", async () => {
    const wallet = createMockWallet("e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1");
    const client = new L402Client({ wallet, budgetSats: 1000 });

    const challengeResponse = new Response(
      JSON.stringify({ error: "Payment Required", amountSats: 50 }),
      {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac1", invoice="lnbc50..."' },
      },
    );
    const successResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });

    mockFetch([challengeResponse, successResponse]);

    await client.get("https://example.com/api");
    expect(client.totalSpent).toBe(50);
    expect(client.remainingBudget).toBe(950);
  });

  test("refuses (does not pay blind) when amountSats is non-numeric and unknown", async () => {
    const wallet = createMockWallet("e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2");
    // Default onUnknownAmount="cap" with no maxPerRequestSats -> refuse.
    const client = new L402Client({ wallet, budgetSats: 1000 });

    const challengeResponse = new Response(
      JSON.stringify({ error: "Payment Required", amountSats: "not a number" }),
      {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac2", invoice="lnbc99..."' },
      },
    );

    mockFetch([challengeResponse]);

    await expect(client.get("https://example.com/api")).rejects.toBeInstanceOf(L402BudgetError);
    expect(wallet.payInvoice).not.toHaveBeenCalled();
    expect(client.totalSpent).toBe(0);
  });

  test("rejects invoice exceeding per-request limit", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, maxPerRequestSats: 10 });

    const challengeResponse = new Response(
      JSON.stringify({ error: "Payment Required", amountSats: 50 }),
      {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac3", invoice="lnbc50..."' },
      },
    );

    mockFetch([challengeResponse]);

    try {
      await client.get("https://example.com/api");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(L402BudgetError);
      expect((err as Error).message).toContain("per-request limit");
      expect(wallet.payInvoice).not.toHaveBeenCalled();
    }
  });

  test("rejects when total budget would be exceeded", async () => {
    const wallet = createMockWallet("e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4");
    const client = new L402Client({ wallet, budgetSats: 100 });

    const make402 = (sats: number) =>
      new Response(JSON.stringify({ amountSats: sats }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac4", invoice="lnbc60..."' },
      });

    mockFetch([
      make402(60),
      new Response("{}", { status: 200 }),
      make402(60),
    ]);

    await client.get("https://example.com/api");
    expect(client.totalSpent).toBe(60);

    try {
      await client.get("https://example.com/api");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(L402BudgetError);
      expect((err as Error).message).toContain("total budget");
    }
  });

  test("spending accumulates across multiple requests", async () => {
    const wallet = createMockWallet("e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    const client = new L402Client({ wallet, budgetSats: 1000 });

    const make402 = (sats: number) =>
      new Response(JSON.stringify({ amountSats: sats }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac5", invoice="lnbc20..."' },
      });

    mockFetch([
      make402(20), new Response("{}", { status: 200 }),
      make402(20), new Response("{}", { status: 200 }),
      make402(20), new Response("{}", { status: 200 }),
    ]);

    await client.get("https://example.com/a");
    await client.get("https://example.com/b");
    await client.get("https://example.com/c");

    expect(client.totalSpent).toBe(60);
    expect(client.remainingBudget).toBe(940);
  });
});

describe("payment retry", () => {
  test("retries transient wallet failures and succeeds", async () => {
    let calls = 0;
    const wallet: WalletAdapter = {
      payInvoice: mock(async () => {
        calls++;
        if (calls < 2) throw new Error("Failed to connect to wss://relay.example.com");
        return { preimage: "0123012301230123012301230123012301230123012301230123012301230123" };
      }),
    };
    const client = new L402Client({ wallet });

    mockFetch([
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 5 }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc10..."' },
      }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("gives up after payRetries and throws L402PaymentError", async () => {
    let calls = 0;
    const wallet: WalletAdapter = {
      payInvoice: mock(async () => {
        calls++;
        throw new Error("no info event (kind 13194) returned from relay");
      }),
    };
    const client = new L402Client({ wallet, payRetries: 1 });

    mockFetch([
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 5 }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc10..."' },
      }),
    ]);

    await expect(client.get("https://example.com/api")).rejects.toThrow("no info event");
    expect(calls).toBe(2);
  });

  test("payRetries: 0 disables retries", async () => {
    let calls = 0;
    const wallet: WalletAdapter = {
      payInvoice: mock(async () => {
        calls++;
        throw new Error("connection failed");
      }),
    };
    const client = new L402Client({ wallet, payRetries: 0 });

    mockFetch([
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 5 }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc10..."' },
      }),
    ]);

    await expect(client.get("https://example.com/api")).rejects.toThrow("connection failed");
    expect(calls).toBe(1);
  });
});

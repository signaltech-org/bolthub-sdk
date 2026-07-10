import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client, L402Error, L402BudgetError } from "../http/client";
import type { WalletAdapter } from "../http/types";

// buyBundle (AF-P7): pay once for an N-use credential, then request() burns a
// use per call (no payment) until the gateway 402s.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wallet(preimage = "beef"): WalletAdapter {
  return { payInvoice: mock(async () => ({ preimage })) };
}

interface Call {
  auth: string | null;
  bundle: string | null;
}

// Scripts fetch to return canned responses and records each call's headers.
function scriptFetch(responses: Response[]) {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ auth: h.get("Authorization"), bundle: h.get("X-Bolthub-Bundle") });
    return responses[i++] ?? new Response("nf", { status: 404 });
  }) as any;
  return calls;
}

function bundleChallenge(): Response {
  return new Response(
    JSON.stringify({ error: "Payment Required", amountSats: 8000, paymentHash: "h1", bundleUses: 100 }),
    { status: 402, headers: { "WWW-Authenticate": 'L402 macaroon="bundlemac", invoice="lnbc8000..."' } },
  );
}

describe("buyBundle", () => {
  test("pays once, then subsequent requests reuse the credential with no payment", async () => {
    const w = wallet("beef");
    const client = new L402Client({ wallet: w });

    const calls = scriptFetch([
      bundleChallenge(), // buyBundle: 402 challenge
      new Response(JSON.stringify({ data: 1 }), { status: 200 }), // request 1 (burn)
      new Response(JSON.stringify({ data: 2 }), { status: 200 }), // request 2 (burn)
    ]);

    const bought = await client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100);
    expect(bought).toEqual({ uses: 100, resource: "https://acme.gw.bolthub.ai/v1/data" });
    expect(w.payInvoice).toHaveBeenCalledTimes(1);
    // The purchase request carried the bundle header.
    expect(calls[0].bundle).toBe("100");

    const r1 = await client.get("https://acme.gw.bolthub.ai/v1/data");
    const r2 = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Still exactly one payment — the bundle credential was reused.
    expect(w.payInvoice).toHaveBeenCalledTimes(1);
    // Both calls presented the cached macaroon:preimage.
    expect(calls[1].auth).toBe("L402 bundlemac:beef");
    expect(calls[2].auth).toBe("L402 bundlemac:beef");
  });

  test("an exhausted bundle (402) is dropped; the next request falls through to normal payment", async () => {
    const w = wallet("beef");
    const client = new L402Client({ wallet: w });

    scriptFetch([
      bundleChallenge(), // buy
      new Response("spent", { status: 402, headers: { "WWW-Authenticate": 'L402 macaroon="x", invoice="lnbc1..."' } }), // reuse -> 402 (exhausted)
      // fall-through normal flow: unauth fetch returns a fresh single-use 402...
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 100, paymentHash: "h2" }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="single", invoice="lnbc100..."' },
      }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }), // retry after single-use pay
    ]);

    await client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100);
    const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
    // Two payments total: the bundle, then the single-use fall-through.
    expect(w.payInvoice).toHaveBeenCalledTimes(2);
  });

  test("rejects a non-402 response (endpoint didn't offer the bundle)", async () => {
    const client = new L402Client({ wallet: wallet() });
    scriptFetch([new Response(JSON.stringify({ ok: true }), { status: 200 })]);
    await expect(
      client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100),
    ).rejects.toThrow(L402Error);
  });

  test("surfaces the server's message on a 400 bad-size", async () => {
    const client = new L402Client({ wallet: wallet() });
    scriptFetch([
      new Response(JSON.stringify({ error: "No 250-use bundle. Available sizes: 100, 500", code: "bundle_size_unavailable" }), {
        status: 400,
      }),
    ]);
    await expect(
      client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 250),
    ).rejects.toThrow(/Available sizes: 100, 500/);
  });

  test("rejects a non-positive size without any network call", async () => {
    const client = new L402Client({ wallet: wallet() });
    const calls = scriptFetch([]);
    await expect(client.buyBundle("https://x/y", 0)).rejects.toThrow(L402Error);
    expect(calls).toHaveLength(0);
  });

  test("bundle payment draws on the shared budget once", async () => {
    const client = new L402Client({ wallet: wallet(), budgetSats: 10000 });
    scriptFetch([bundleChallenge(), new Response("{}", { status: 200 })]);
    await client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100);
    expect(client.totalSpent).toBe(8000);
    expect(client.remainingBudget).toBe(2000);
  });

  // Budget boundary: a bundle priced exactly at the remaining budget is
  // affordable (the check is <=, not <). It spends the budget to zero.
  test("bundle price exactly equal to the remaining budget is allowed", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w, budgetSats: 8000 });
    scriptFetch([bundleChallenge(), new Response("{}", { status: 200 })]);
    await client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100);
    expect(w.payInvoice).toHaveBeenCalledTimes(1);
    expect(client.totalSpent).toBe(8000);
    expect(client.remainingBudget).toBe(0);
  });

  // Budget boundary: one sat over the remaining budget is refused BEFORE the
  // wallet is touched — an over-budget bundle must never pay.
  test("bundle one sat over budget is refused without paying", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w, budgetSats: 7999 });
    scriptFetch([bundleChallenge(), new Response("{}", { status: 200 })]);
    await expect(
      client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100),
    ).rejects.toThrow(L402BudgetError);
    expect(w.payInvoice).not.toHaveBeenCalled();
    expect(client.totalSpent).toBe(0);
  });

  // maxCostSats caps this one purchase: equal to the price is allowed, below
  // it is refused pre-payment (independent of the total budget).
  test("maxCostSats equal to the bundle price is allowed", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w });
    scriptFetch([bundleChallenge(), new Response("{}", { status: 200 })]);
    await client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100, { maxCostSats: 8000 });
    expect(w.payInvoice).toHaveBeenCalledTimes(1);
  });

  test("maxCostSats below the bundle price is refused without paying", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w });
    scriptFetch([bundleChallenge(), new Response("{}", { status: 200 })]);
    await expect(
      client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100, { maxCostSats: 7999 }),
    ).rejects.toThrow(L402BudgetError);
    expect(w.payInvoice).not.toHaveBeenCalled();
  });

  // The phantom-bundle guard (the delegation smoke test's step-5/6/7 failure):
  // a 402 challenge WITHOUT a bundleUses echo is a plain single-use invoice the
  // server minted after ignoring (or refusing) the bundle header. Paying it and
  // caching it as an N-use bundle silently reverts to per-call payment after
  // one use — so the purchase must be refused BEFORE the wallet is touched,
  // and nothing may be cached.
  test("refuses to pay when the server does not echo bundleUses (no phantom bundle)", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w });
    const calls = scriptFetch([
      // Single-use challenge: no bundleUses in the body.
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 3, paymentHash: "h1" }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="single", invoice="lnbc3..."' },
      }),
      // The follow-up get() must run the NORMAL unauthenticated flow (no
      // cached credential presented).
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 3, paymentHash: "h2" }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="single2", invoice="lnbc3..."' },
      }),
      new Response("{}", { status: 200 }),
    ]);

    await expect(
      client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100),
    ).rejects.toThrow(/did not honor the bundle request/);
    expect(w.payInvoice).not.toHaveBeenCalled();

    // Nothing was cached: the next request starts unauthenticated.
    const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
    expect(calls[1].auth).toBeNull();
  });

  test("refuses to pay when the server echoes a different size", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w });
    scriptFetch([
      new Response(
        JSON.stringify({ error: "Payment Required", amountSats: 8000, paymentHash: "h1", bundleUses: 50 }),
        { status: 402, headers: { "WWW-Authenticate": 'L402 macaroon="m", invoice="lnbc8000..."' } },
      ),
    ]);
    await expect(
      client.buyBundle("https://acme.gw.bolthub.ai/v1/data", 100),
    ).rejects.toThrow(/offered a 50-use bundle, not the 100 requested/);
    expect(w.payInvoice).not.toHaveBeenCalled();
  });

  // Structured grant refusals (bundle_exhausted / token_revoked /
  // not_bundle_backed) are 402s WITHOUT a challenge. They must surface as the
  // server's own code and message — the deterministic "stop, don't retry"
  // answer — not as a challenge-parse error.
  test("request() surfaces a structured 402 refusal with the server's code", async () => {
    const client = new L402Client({ wallet: wallet() });
    scriptFetch([
      new Response(
        JSON.stringify({ error: "Bundle revoked", code: "token_revoked" }),
        { status: 402 }, // no WWW-Authenticate: a refusal, not a challenge
      ),
    ]);
    await expect(
      client.get("https://acme.gw.bolthub.ai/v1/data"),
    ).rejects.toThrow(/Payment refused: Bundle revoked \[token_revoked\]/);
  });
});

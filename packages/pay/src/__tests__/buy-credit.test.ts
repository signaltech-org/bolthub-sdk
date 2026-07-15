import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client, L402Error, L402BudgetError } from "../http/client";
import type { WalletAdapter } from "../http/types";

// buyCredit (cross-endpoint prepaid credit): pay once per PROVIDER (host), then
// request() to ANY of that provider's endpoints draws the credit — no payment —
// until it's spent. Credit is FACE-VALUE: the client passes a sats budget and
// the server charges exactly that, with no discount tiers. The distinguishing
// property vs a single-endpoint credential: cross-endpoint reuse per host.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wallet(preimage = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef"): WalletAdapter {
  return { payInvoice: mock(async () => ({ preimage })) };
}

interface Call {
  url: string;
  auth: string | null;
  credit: string | null;
}

function scriptFetch(responses: Response[]) {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), auth: h.get("Authorization"), credit: h.get("X-Bolthub-Credit") });
    return responses[i++] ?? new Response("nf", { status: 404 });
  }) as any;
  return calls;
}

// An HONORED credit challenge echoes `creditSats` (== the requested budget).
function creditChallenge(creditSats = 10000): Response {
  return new Response(
    JSON.stringify({ error: "Payment Required", amountSats: creditSats, paymentHash: "h1", creditSats }),
    { status: 402, headers: { "WWW-Authenticate": 'L402 macaroon="creditmac", invoice="lnbc10000..."' } },
  );
}

describe("buyCredit", () => {
  test("pays once, then reuses across DIFFERENT endpoints of the same provider", async () => {
    const w = wallet("beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
    const client = new L402Client({ wallet: w });
    const calls = scriptFetch([
      creditChallenge(), // buyCredit
      new Response(JSON.stringify({ a: 1 }), { status: 200 }), // /v1/a
      new Response(JSON.stringify({ b: 2 }), { status: 200 }), // /v1/b (same host!)
    ]);

    const bought = await client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 10000);
    expect(bought).toEqual({ creditSats: 10000, host: "acme.gw.bolthub.ai" });
    expect(calls[0].credit).toBe("10000");

    const r1 = await client.get("https://acme.gw.bolthub.ai/v1/a");
    const r2 = await client.get("https://acme.gw.bolthub.ai/v1/b");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(w.payInvoice).toHaveBeenCalledTimes(1); // ONE payment for both endpoints
    expect(calls[1].auth).toBe("L402 creditmac:beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
    expect(calls[2].auth).toBe("L402 creditmac:beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
  });

  test("does NOT reuse credit on a different provider (different host)", async () => {
    const w = wallet();
    // Budget exactly covers the one credit purchase, so nothing is left to pay a
    // second provider — if credit leaked across hosts the other call would be free.
    const client = new L402Client({ wallet: w, budgetSats: 10000 });
    scriptFetch([creditChallenge()]);
    await client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 10000);
    // A call to the OTHER provider has no credit → normal flow → 402 → tries to
    // pay → budget spent → throws. Proves credit is host-scoped, not global.
    globalThis.fetch = mock(async () =>
      new Response("pay", { status: 402, headers: { "WWW-Authenticate": 'L402 macaroon="x", invoice="lnbc1..."' } }),
    ) as any;
    await expect(client.get("https://other.gw.bolthub.ai/v1/data")).rejects.toThrow(L402BudgetError);
  });

  test("spent credit (402) drops and falls through to a single-use payment", async () => {
    const w = wallet("beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
    const client = new L402Client({ wallet: w });
    scriptFetch([
      creditChallenge(), // buy
      new Response("spent", { status: 402, headers: { "WWW-Authenticate": 'L402 macaroon="x", invoice="lnbc1..."' } }), // reuse -> spent
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 100, paymentHash: "h2" }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="single", invoice="lnbc100..."' },
      }),
      new Response("{}", { status: 200 }),
    ]);
    await client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 10000);
    const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
    expect(w.payInvoice).toHaveBeenCalledTimes(2); // credit + fall-through single-use
  });

  test("SECURITY: refuses and pays NOTHING when the server does not echo creditSats", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w });
    // Honored-looking 402 (has an invoice) but NO creditSats echo: the server
    // minted a plain single-use invoice, not a credit budget. Paying it would be
    // a phantom purchase. buyCredit must refuse before the wallet is touched.
    const calls = scriptFetch([
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 10000, paymentHash: "h1" }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="notcredit", invoice="lnbc10000..."' },
      }),
    ]);
    await expect(client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 10000)).rejects.toThrow(
      /did not honor the credit request|no creditSats/,
    );
    expect(w.payInvoice).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // only the challenge fetch; nothing was retried/paid
    // And nothing was cached: a later call gets the normal flow, not free credit.
    expect(client.getSessions().size).toBe(0);
  });

  test("SECURITY: refuses and pays NOTHING when the server echoes a DIFFERENT creditSats", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w });
    // Server echoes 5000 (its own smaller budget) for a 10000 request — a
    // mismatch. Caching it as 10000 credit would over-state the budget. Refuse.
    scriptFetch([creditChallenge(5000)]);
    await expect(client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 10000)).rejects.toThrow(
      /honored 5000 sats of credit, not the 10000/,
    );
    expect(w.payInvoice).not.toHaveBeenCalled();
  });

  test("unavailable credit surfaces the server's refusal message", async () => {
    const client = new L402Client({ wallet: wallet() });
    scriptFetch([
      new Response(
        JSON.stringify({ error: "Prepaid credit is not enabled for this provider", code: "credit_unavailable" }),
        { status: 400 },
      ),
    ]);
    await expect(client.buyCredit("https://x/y", 25000)).rejects.toThrow(/not enabled for this provider/);
  });

  test("rejects a non-positive amount without any network call", async () => {
    const client = new L402Client({ wallet: wallet() });
    const calls = scriptFetch([]);
    await expect(client.buyCredit("https://x/y", 0)).rejects.toThrow(L402Error);
    expect(calls).toHaveLength(0);
  });

  test("over-budget credit is refused before the wallet is touched", async () => {
    const w = wallet();
    const client = new L402Client({ wallet: w, budgetSats: 9999 });
    scriptFetch([creditChallenge(), new Response("{}", { status: 200 })]);
    await expect(client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 10000)).rejects.toThrow(L402BudgetError);
    expect(w.payInvoice).not.toHaveBeenCalled();
  });

  test("clearCredits drops the cached credential (next call pays again)", async () => {
    const w = wallet("beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
    const client = new L402Client({ wallet: w });
    scriptFetch([
      creditChallenge(), // buy
      new Response(JSON.stringify({ error: "Payment Required", amountSats: 100, paymentHash: "h2" }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="single", invoice="lnbc100..."' },
      }),
      new Response("{}", { status: 200 }),
    ]);
    await client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 10000);
    client.clearCredits();
    const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
    expect(w.payInvoice).toHaveBeenCalledTimes(2); // credit + a fresh single-use pay
  });
});

describe("batchFetch", () => {
  test("one payment per provider, then fetches every url", async () => {
    const w = wallet("beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
    const client = new L402Client({ wallet: w });
    // acme buy, then bolt buy, then 3 fetches — group by host: acme + bolt.
    // concurrency: 1 keeps the fetch order deterministic for counting.
    const calls = scriptFetch([
      creditChallenge(), // buy acme
      creditChallenge(), // buy bolt
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
    ]);
    const res = await client.batchFetch(
      [
        "https://acme.gw.bolthub.ai/v1/a",
        "https://acme.gw.bolthub.ai/v1/b",
        "https://bolt.gw.bolthub.ai/v1/c",
      ],
      { creditSats: 10000, concurrency: 1 },
    );
    expect(res).toHaveLength(3);
    expect(res.every((r) => r.status === 200)).toBe(true);
    // TWO payments (acme + bolt) for THREE calls across two providers.
    expect(w.payInvoice).toHaveBeenCalledTimes(2);
    // The purchase requests carried the credit header.
    expect(calls.filter((c) => c.credit === "10000")).toHaveLength(2);
  });
});

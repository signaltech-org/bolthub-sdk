/**
 * 429/Retry-After handling in L402Client (rate-limit audit V3).
 *
 * Pins: every leg (challenge, session reuse, post-payment retry) waits out
 * Retry-After and re-sends; the post-payment retry re-presents the SAME
 * macaroon:preimage (gateways revert consumption on 429, so this re-uses
 * the payment — see docs/ratelimit-audit/MATRIX.md); waits beyond
 * maxRetryAfterMs and exhausted retries surface the 429 unchanged.
 */

import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client } from "../http/client";
import type { WalletAdapter } from "../http/types";

function createMockWallet(preimage = "abc123"): WalletAdapter {
  return {
    payInvoice: mock(async () => ({ preimage })),
  };
}

const originalFetch = globalThis.fetch;

/** Queue canned responses and record every (url, init) fetch received. */
function mockFetchRecording(responses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses[i++] ?? new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function tooMany(retryAfter?: string) {
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: retryAfter !== undefined ? { "Retry-After": retryAfter } : {},
  });
}

function challenge(amountSats = 10) {
  return new Response(JSON.stringify({ error: "Payment Required", amountSats }), {
    status: 402,
    headers: {
      "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."',
    },
  });
}

describe("L402Client 429 handling", () => {
  test("challenge leg: waits out Retry-After and re-sends", async () => {
    const client = new L402Client({ wallet: createMockWallet() });
    const calls = mockFetchRecording([
      tooMany("0"),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  test("post-payment leg: retries with the SAME L402 proof, pays exactly once", async () => {
    const wallet = createMockWallet("preimage123");
    const client = new L402Client({ wallet });
    const calls = mockFetchRecording([
      challenge(),
      tooMany("0"),
      new Response(JSON.stringify({ data: "hello" }), { status: 200 }),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1);

    const authOf = (i: number) => new Headers(calls[i].init?.headers).get("Authorization");
    expect(authOf(1)).toBe("L402 mac123:preimage123");
    expect(authOf(2)).toBe("L402 mac123:preimage123");
  });

  test("session reuse leg: 429 is retried without dropping the session", async () => {
    const client = new L402Client({ wallet: createMockWallet() });
    // Establish a session the way gateways do: pay once, session headers
    // arrive on the post-payment response.
    mockFetchRecording([
      challenge(),
      new Response("ok", {
        status: 200,
        headers: {
          "X-Session-Token": "sess_1",
          "X-Session-Expires": new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    ]);
    await client.get("https://example.com/api");

    const calls = mockFetchRecording([
      tooMany("0"),
      new Response("ok again", { status: 200 }),
    ]);
    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(2);
    const tokenOf = (i: number) => new Headers(calls[i].init?.headers).get("X-Session-Token");
    expect(tokenOf(0)).toBe("sess_1");
    expect(tokenOf(1)).toBe("sess_1");
  });

  test("Retry-After beyond maxRetryAfterMs surfaces the 429 immediately", async () => {
    const client = new L402Client({ wallet: createMockWallet(), maxRetryAfterMs: 5_000 });
    const calls = mockFetchRecording([tooMany("3600")]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(429);
    expect(calls.length).toBe(1);
  });

  test("retries are bounded: exhausted attempts return the last 429", async () => {
    const client = new L402Client({ wallet: createMockWallet(), rateLimitRetries: 2 });
    const calls = mockFetchRecording([tooMany("0"), tooMany("0"), tooMany("0"), tooMany("0")]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(429);
    expect(calls.length).toBe(3); // initial + 2 retries
  });

  test("rateLimitRetries: 0 disables the behavior", async () => {
    const client = new L402Client({ wallet: createMockWallet(), rateLimitRetries: 0 });
    const calls = mockFetchRecording([tooMany("0")]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(429);
    expect(calls.length).toBe(1);
  });

  test("HTTP-date Retry-After values are honored", async () => {
    const client = new L402Client({ wallet: createMockWallet() });
    const calls = mockFetchRecording([
      tooMany(new Date(Date.now() - 1000).toUTCString()), // already past → wait 0
      new Response("ok", { status: 200 }),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(2);
  });
});

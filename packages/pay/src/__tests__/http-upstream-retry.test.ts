import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client, UpstreamFailedError } from "../http/client";
import { readPaymentStatus, PAYMENT_HEADER, PAYMENT_CODE_HEADER } from "../http/payment-status";
import type { WalletAdapter } from "../http/types";

function createMockWallet(preimage = "abc123"): WalletAdapter {
  return {
    payInvoice: mock(async () => ({ preimage })),
  };
}

const originalFetch = globalThis.fetch;

function mockFetch(responses: Response[]) {
  let callIndex = 0;
  const fn = mock(async () => {
    return responses[callIndex++] ?? new Response("Not found", { status: 404 });
  });
  globalThis.fetch = fn as any;
  return fn;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function challenge(): Response {
  return new Response(JSON.stringify({ error: "Payment Required", amountSats: 10 }), {
    status: 402,
    headers: { "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1000..."' },
  });
}

function revertedFailure(status = 502): Response {
  return new Response(JSON.stringify({ error: "Origin connection failed" }), {
    status,
    headers: {
      [PAYMENT_HEADER]: "reverted",
      [PAYMENT_CODE_HEADER]: "upstream_failed_retryable",
    },
  });
}

describe("readPaymentStatus", () => {
  test("returns null without the header", () => {
    expect(readPaymentStatus(new Headers())).toBeNull();
  });

  test("parses state and code", () => {
    const h = new Headers({
      [PAYMENT_HEADER]: "refunded_to_balance",
      [PAYMENT_CODE_HEADER]: "upstream_failed_retryable",
    });
    expect(readPaymentStatus(h)).toEqual({
      state: "refunded_to_balance",
      code: "upstream_failed_retryable",
    });
  });

  test("state without code", () => {
    const h = new Headers({ [PAYMENT_HEADER]: "charged" });
    expect(readPaymentStatus(h)).toEqual({ state: "charged", code: undefined });
  });
});

describe("upstream failure retry", () => {
  test("retries for free on upstream_failed_retryable and succeeds — single payment", async () => {
    const wallet = createMockWallet("preimage123");
    const client = new L402Client({ wallet });

    const fetchFn = mockFetch([
      challenge(),
      revertedFailure(), // post-payment leg fails, gateway reverted
      new Response(JSON.stringify({ data: "hello" }), { status: 200 }),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1); // retry was free
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("bare 5xx WITHOUT the header is returned untouched (no blind retries)", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet });

    const fetchFn = mockFetch([
      challenge(),
      new Response("boom", { status: 502 }), // no payment-status headers
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(502);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("exhausted retries return the final failed response by default", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, upstreamRetries: 2 });

    const fetchFn = mockFetch([
      challenge(),
      revertedFailure(),
      revertedFailure(),
      revertedFailure(),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(502);
    expect(readPaymentStatus(resp.headers)?.state).toBe("reverted");
    expect(fetchFn).toHaveBeenCalledTimes(4); // challenge + 1 initial + 2 retries
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1);
  });

  test("retryOnUpstreamFailure: false returns the first failure", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet, retryOnUpstreamFailure: false });

    const fetchFn = mockFetch([challenge(), revertedFailure()]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(502);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("throwOnUpstreamFailure throws a typed error carrying the payment status", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({
      wallet,
      upstreamRetries: 1,
      throwOnUpstreamFailure: true,
    });

    mockFetch([challenge(), revertedFailure(), revertedFailure()]);

    try {
      await client.get("https://example.com/api");
      throw new Error("expected UpstreamFailedError");
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamFailedError);
      const e = err as UpstreamFailedError;
      expect(e.retryable).toBe(true);
      expect(e.httpStatus).toBe(502);
      expect(e.attempts).toBe(2);
      expect(e.paymentStatus.state).toBe("reverted");
      expect(e.paymentStatus.code).toBe("upstream_failed_retryable");
      expect(e.resource).toBe("https://example.com/api");
    }
  });

  test("session-reuse leg also retries on refunded_to_balance", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet });

    // First call buys a session.
    mockFetch([
      challenge(),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "X-Session-Token": "sess-1",
          "X-Session-Expires": new Date(Date.now() + 3600_000).toISOString(),
          "X-Session-Balance": "90",
        },
      }),
    ]);
    await client.get("https://example.com/api");
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1);

    // Second call rides the session; gateway 5xx refunds the deduction, retry succeeds.
    const fetchFn = mockFetch([
      new Response("origin down", {
        status: 500,
        headers: {
          [PAYMENT_HEADER]: "refunded_to_balance",
          [PAYMENT_CODE_HEADER]: "upstream_failed_retryable",
          "X-Session-Token": "sess-1",
          "X-Session-Balance": "90",
        },
      }),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "X-Session-Token": "sess-1", "X-Session-Balance": "80" },
      }),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1); // still just the one payment
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("charged + upstream_rejected (real 4xx answer) is never retried", async () => {
    const wallet = createMockWallet();
    const client = new L402Client({ wallet });

    const fetchFn = mockFetch([
      challenge(),
      new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        headers: {
          [PAYMENT_HEADER]: "charged",
          [PAYMENT_CODE_HEADER]: "upstream_rejected",
        },
      }),
    ]);

    const resp = await client.get("https://example.com/api");
    expect(resp.status).toBe(400);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

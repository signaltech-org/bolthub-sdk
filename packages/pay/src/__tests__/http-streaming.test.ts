import { describe, test, expect, afterEach } from "bun:test";
import { L402Client, L402TimeoutError } from "../http/client";
import type { WalletAdapter } from "../http/types";

/**
 * Streaming-mode contract of L402Client.request (hub-streaming P2):
 * with `streaming: true`, `timeoutMs` bounds only time-to-headers on each
 * leg; a live SSE body is never timed out and is stopped via the caller's
 * `signal`. Uses a real Bun.serve origin because the thing under test is
 * abort/timeout interaction with an actual open socket, which fetch mocks
 * can't reproduce faithfully.
 */

const PREIMAGE = "a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1";

function mockWallet(): WalletAdapter {
  return { payInvoice: async () => ({ preimage: PREIMAGE }) };
}

/** 200 SSE response that emits `data: tick N` every `intervalMs` forever. */
function endlessSse(intervalMs: number): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let n = 0;
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(": hello\n\n"));
      timer = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`data: tick ${n++}\n\n`));
        } catch {
          clearInterval(timer);
        }
      }, intervalMs);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Read SSE frames until `count` data events arrived, then release. */
async function readEvents(resp: Response, count: number): Promise<string[]> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: string[] = [];
  while (events.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.startsWith("data: ")) events.push(frame.slice(6));
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("L402Client streaming mode", () => {
  test("an endless SSE body outlives timeoutMs and is read live", async () => {
    server = Bun.serve({ port: 0, fetch: () => endlessSse(30) });
    const client = new L402Client({ wallet: mockWallet(), timeoutMs: 120 });

    const resp = await client.request(`http://localhost:${server.port}/stream`, {
      streaming: true,
    });
    expect(resp.status).toBe(200);

    // 5 events at 30ms spacing ≈ 150ms+ of body time, past the 120ms
    // timeout that would have killed a buffered read.
    const events = await readEvents(resp, 5);
    expect(events).toEqual(["tick 0", "tick 1", "tick 2", "tick 3", "tick 4"]);
  });

  test("timeoutMs still bounds time-to-headers in streaming mode", async () => {
    server = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 1_000));
        return endlessSse(30);
      },
    });
    const client = new L402Client({ wallet: mockWallet(), timeoutMs: 100 });

    expect(
      client.request(`http://localhost:${server.port}/slow`, { streaming: true }),
    ).rejects.toBeInstanceOf(L402TimeoutError);
  });

  test("the caller's signal stops a live stream mid-body", async () => {
    server = Bun.serve({ port: 0, fetch: () => endlessSse(20) });
    const client = new L402Client({ wallet: mockWallet(), timeoutMs: 5_000 });
    const ctrl = new AbortController();

    const resp = await client.request(`http://localhost:${server.port}/stream`, {
      streaming: true,
      signal: ctrl.signal,
    });

    const reader = resp.body!.getReader();
    await reader.read(); // at least one chunk flowed
    ctrl.abort();

    // The pending/next read must reject with the abort, not hang.
    let aborted = false;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      aborted = true;
    }
    expect(aborted).toBe(true);
  });

  test("an already-aborted signal rejects immediately, buffered mode too", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("{}") });
    const client = new L402Client({ wallet: mockWallet(), timeoutMs: 5_000 });
    const ctrl = new AbortController();
    ctrl.abort();

    expect(
      client.request(`http://localhost:${server.port}/api`, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });

  test("buffered default is unchanged: timeout kills an endless body read", async () => {
    server = Bun.serve({ port: 0, fetch: () => endlessSse(30) });
    const client = new L402Client({ wallet: mockWallet(), timeoutMs: 120 });

    // No `streaming` flag: the composed timeout stays armed for the body,
    // so buffering the endless stream aborts with TimeoutError as before.
    const resp = await client.request(`http://localhost:${server.port}/stream`);
    expect(resp.status).toBe(200);
    let name: string | undefined;
    try {
      await resp.text();
    } catch (err) {
      name = err instanceof DOMException ? err.name : undefined;
    }
    expect(name).toBe("TimeoutError");
  });

  test("the paid retry leg streams: 402 → pay → live SSE past timeoutMs", async () => {
    let sawAuth: string | null = null;
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const auth = req.headers.get("authorization");
        if (!auth) {
          return new Response(JSON.stringify({ error: "Payment Required", amountSats: 10 }), {
            status: 402,
            headers: {
              "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc10n1..."',
            },
          });
        }
        sawAuth = auth;
        return endlessSse(30);
      },
    });
    const client = new L402Client({ wallet: mockWallet(), timeoutMs: 120 });

    const resp = await client.request(`http://localhost:${server.port}/paid-stream`, {
      streaming: true,
    });
    expect(resp.status).toBe(200);
    expect(sawAuth).toBe(`L402 mac123:${PREIMAGE}`);

    const events = await readEvents(resp, 5);
    expect(events).toHaveLength(5);
  });
});

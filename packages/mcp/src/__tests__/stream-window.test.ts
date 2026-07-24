import { describe, expect, test } from "bun:test";
import {
  activePassExpiry,
  clampStreamCaps,
  formatStreamWindow,
  isEventStreamResponse,
  readStreamWindow,
  STREAM_DEFAULT_EVENTS,
  STREAM_DEFAULT_SECONDS,
} from "../sources/stream-window";

const enc = new TextEncoder();

/** SSE response emitting chunks with gaps; endless unless closed. */
function sseResponse(
  chunks: string[],
  { gapMs = 0, endless = false }: { gapMs?: number; endless?: boolean } = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const c of chunks) {
          if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
          controller.enqueue(enc.encode(c));
        }
        if (!endless) controller.close();
      } catch {
        /* cancelled mid-emit */
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("clampStreamCaps", () => {
  test("defaults apply when args are absent", () => {
    expect(clampStreamCaps({})).toEqual({
      maxEvents: STREAM_DEFAULT_EVENTS,
      maxMs: STREAM_DEFAULT_SECONDS * 1000,
    });
  });

  test("caps clamp to the maxima and floor at 1", () => {
    expect(clampStreamCaps({ stream_events: 9999, stream_seconds: 9999 })).toEqual({
      maxEvents: 200,
      maxMs: 60_000,
    });
    expect(clampStreamCaps({ stream_events: 0, stream_seconds: 0 })).toEqual({
      maxEvents: 1,
      maxMs: 1000,
    });
    expect(clampStreamCaps({ stream_events: -5 }).maxEvents).toBe(1);
  });
});

describe("isEventStreamResponse", () => {
  test("matches with charset, rejects json", () => {
    expect(
      isEventStreamResponse(
        new Response("", { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
      ),
    ).toBe(true);
    expect(
      isEventStreamResponse(
        new Response("", { headers: { "content-type": "application/json" } }),
      ),
    ).toBe(false);
  });
});

describe("readStreamWindow", () => {
  test("collects events and stops at the event cap", async () => {
    const resp = sseResponse([
      "event: liquidation\ndata: {\"n\":1}\n\n",
      "data: {\"n\":2}\n\n",
      "data: {\"n\":3}\n\n",
    ]);
    const w = await readStreamWindow(resp, { maxEvents: 2, maxMs: 5000 });
    expect(w.events).toHaveLength(2);
    expect(w.reason).toBe("cap_events");
    expect(w.events[0].event).toBe("liquidation");
  });

  test("origin close ends the window with remaining events", async () => {
    const resp = sseResponse(["data: only\n\n"]);
    const w = await readStreamWindow(resp, { maxEvents: 20, maxMs: 5000 });
    expect(w.events).toHaveLength(1);
    expect(w.reason).toBe("origin_closed");
  });

  test("time cap fires on an endless quiet stream, keepalives counted", async () => {
    const resp = sseResponse([": keep-alive\n\n", ": keep-alive\n\n"], {
      gapMs: 10,
      endless: true,
    });
    const started = Date.now();
    const w = await readStreamWindow(resp, { maxEvents: 20, maxMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(w.events).toHaveLength(0);
    expect(w.keepalives).toBe(2);
    expect(w.reason).toBe("cap_seconds");
  });

  test("terminal payment_required frame ends the window and is not an event", async () => {
    const resp = sseResponse([
      "data: last\n\n",
      "event: payment_required\ndata: {\"reason\":\"expired\"}\n\n",
      "data: never-seen\n\n",
    ]);
    const w = await readStreamWindow(resp, { maxEvents: 20, maxMs: 5000 });
    expect(w.events.map((e) => e.data)).toEqual(["last"]);
    expect(w.reason).toBe("payment_required");
  });
});

describe("formatStreamWindow", () => {
  const caps = { maxEvents: 20, maxMs: 10_000 };

  test("events render as JSON lines with parsed data and a close reason", () => {
    const out = formatStreamWindow(
      {
        events: [
          { event: "liquidation", data: '{"usd":50000}', id: null, comment: false },
          { event: null, data: "plain", id: null, comment: false },
        ],
        reason: "cap_events",
        keepalives: 1,
        durationMs: 4200,
      },
      caps,
      " · cost: 1000 sats",
    );
    expect(out).toContain("[stream] 2 events in 4.2s");
    expect(out).toContain("cost: 1000 sats");
    expect(out).toContain('{"event":"liquidation","data":{"usd":50000}}');
    expect(out).toContain('{"data":"plain"}');
    expect(out).toContain("window cap reached");
  });

  test("zero events on a healthy connection reads as success, not failure", () => {
    const out = formatStreamWindow(
      { events: [], reason: "cap_seconds", keepalives: 3, durationMs: 10_000 },
      caps,
      "",
    );
    expect(out).toContain("connection healthy (3 keep-alives received)");
    expect(out).toContain("currently quiet, which is normal");
    expect(out).not.toContain("error");
  });

  test("paid-window expiry is stated explicitly", () => {
    const out = formatStreamWindow(
      { events: [], reason: "payment_required", keepalives: 0, durationMs: 500 },
      caps,
      "",
    );
    expect(out).toContain("the paid window ended");
  });

  // 2026-07-24 smoke finding F10: the close line claimed "a new payment on
  // paid endpoints" even when the next window was free under an active pass.
  test("close line says the next window is free under an active pass", () => {
    const out = formatStreamWindow(
      {
        events: [{ event: null, data: "x", id: null, comment: false }],
        reason: "cap_events",
        keepalives: 0,
        durationMs: 1000,
      },
      caps,
      " · 0 sats (covered by active pass)",
      new Date("2026-07-25T00:00:00Z"),
    );
    expect(out).toContain("free under your active pass until 2026-07-25T00:00:00.000Z");
    expect(out).not.toContain("a new payment on paid endpoints");
  });
});

describe("activePassExpiry", () => {
  test("active session on the exact URL wins; expired/missing/undefined do not", () => {
    const future = Date.now() + 60_000;
    const client = {
      getSessions: () => new Map([["api.gw/v1/stream", { expiresAt: future }]]),
    };
    expect(activePassExpiry(client, "https://api.gw/v1/stream")?.getTime()).toBe(future);
    expect(activePassExpiry(client, "https://api.gw/v1/other")).toBeUndefined();

    const expired = {
      getSessions: () => new Map([["api.gw/v1/stream", { expiresAt: Date.now() - 1 }]]),
    };
    expect(activePassExpiry(expired, "https://api.gw/v1/stream")).toBeUndefined();
    expect(activePassExpiry(undefined, "https://api.gw/v1/stream")).toBeUndefined();
    // Legacy fakes without getSessions must not throw.
    expect(activePassExpiry({} as { getSessions?: () => Map<string, { expiresAt: number }> }, "https://api.gw/v1/stream")).toBeUndefined();
  });
});

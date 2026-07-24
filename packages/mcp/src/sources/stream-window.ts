/**
 * Windowed consumption of a live SSE response for MCP tool results
 * (docs/design/mcp-streaming/SPIKE.md §6). A tool result is one
 * complete message, so a stream is read as a bounded window: collect
 * data events until an event/time cap, then cancel the body cleanly.
 * The same reader drives Phase B's background subscriptions.
 */

import { SseParser, type SseFrame } from "@bolthub/pay";

export const STREAM_DEFAULT_EVENTS = 20;
export const STREAM_MAX_EVENTS = 200;
export const STREAM_DEFAULT_SECONDS = 10;
export const STREAM_MAX_SECONDS = 60;

export type StreamCloseReason =
  | "cap_events"
  | "cap_seconds"
  | "origin_closed"
  | "payment_required"
  | "aborted"
  | "error";

export interface StreamWindow {
  /** Data frames collected (keep-alive comments excluded). */
  events: SseFrame[];
  reason: StreamCloseReason;
  /** Keep-alive comment frames seen — proof of connection liveness. */
  keepalives: number;
  durationMs: number;
  /** Present when reason is "error". */
  errorMessage?: string;
}

export function clampStreamCaps(args: {
  stream_events?: number;
  stream_seconds?: number;
}): { maxEvents: number; maxMs: number } {
  const events = Number.isFinite(args.stream_events)
    ? Math.min(Math.max(1, Math.floor(args.stream_events!)), STREAM_MAX_EVENTS)
    : STREAM_DEFAULT_EVENTS;
  const seconds = Number.isFinite(args.stream_seconds)
    ? Math.min(Math.max(1, args.stream_seconds!), STREAM_MAX_SECONDS)
    : STREAM_DEFAULT_SECONDS;
  return { maxEvents: events, maxMs: seconds * 1000 };
}

export function isEventStreamResponse(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

/**
 * Read one bounded window off a live SSE body, then cancel the stream
 * (the server sees a normal client disconnect). The gateway's terminal
 * `event: payment_required` frame ends the window early — it means the
 * paid window lapsed, and it is not included in `events`.
 */
export async function readStreamWindow(
  resp: Response,
  caps: { maxEvents: number; maxMs: number },
): Promise<StreamWindow> {
  const started = Date.now();
  const body = resp.body;
  if (!body) {
    return { events: [], reason: "origin_closed", keepalives: 0, durationMs: 0 };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const events: SseFrame[] = [];
  let keepalives = 0;
  let reason: StreamCloseReason = "origin_closed";
  let errorMessage: string | undefined;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, caps.maxMs);

  try {
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        reason = timedOut ? "cap_seconds" : "origin_closed";
        break;
      }
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (frame.comment) {
          keepalives += 1;
          continue;
        }
        if (frame.event === "payment_required") {
          reason = "payment_required";
          break outer;
        }
        events.push(frame);
        if (events.length >= caps.maxEvents) {
          reason = "cap_events";
          break outer;
        }
      }
    }
  } catch (err) {
    if (timedOut) {
      reason = "cap_seconds";
    } else {
      reason = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }

  return { events, reason, keepalives, durationMs: Date.now() - started, errorMessage };
}

function closeLine(w: StreamWindow, caps: { maxEvents: number; maxMs: number }): string {
  switch (w.reason) {
    case "cap_events":
      return `[stream closed: ${caps.maxEvents}-event window cap reached — call again for a new window (a new payment on paid endpoints)]`;
    case "cap_seconds":
      return `[stream closed: ${Math.round(caps.maxMs / 1000)}s window cap reached — call again for a new window (a new payment on paid endpoints)]`;
    case "payment_required":
      return "[stream closed by the gateway: the paid window ended (event: payment_required). Pay again to reconnect.]";
    case "origin_closed":
      return "[stream closed by the origin]";
    case "aborted":
      return "[stream closed]";
    case "error":
      return `[stream error: ${w.errorMessage ?? "read failed"}]`;
  }
}

/**
 * Render a window as tool-result text: a header line, one JSON line per
 * event (machine-readable without blowing the context), and a close
 * line saying WHY it ended. A zero-event window on a healthy connection
 * is reported as SUCCESS — event-driven feeds are often quiet, and an
 * agent must not read silence as failure.
 */
export function formatStreamWindow(
  w: StreamWindow,
  caps: { maxEvents: number; maxMs: number },
  costLine: string,
): string {
  const secs = (w.durationMs / 1000).toFixed(1);
  const header = `[stream] ${w.events.length} event${w.events.length === 1 ? "" : "s"} in ${secs}s (cap: ${caps.maxEvents} events / ${Math.round(caps.maxMs / 1000)}s)${costLine}`;

  const lines = w.events.map((e) =>
    JSON.stringify({ ...(e.event ? { event: e.event } : {}), data: tryParse(e.data) }),
  );

  if (w.events.length === 0 && (w.reason === "cap_seconds" || w.reason === "cap_events")) {
    const liveness = w.keepalives > 0
      ? `connection healthy (${w.keepalives} keep-alive${w.keepalives === 1 ? "" : "s"} received)`
      : "connection open";
    return `${header}\n[no events this window — ${liveness}; this feed is event-driven and currently quiet, which is normal]`;
  }

  return [header, ...lines, closeLine(w, caps)].join("\n");
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

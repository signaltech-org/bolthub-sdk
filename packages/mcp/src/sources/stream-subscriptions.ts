/**
 * Background stream subscriptions for MCP agents
 * (docs/design/mcp-streaming/SPIKE.md §7): open_stream pays once and
 * holds the live SSE connection in this process; read_stream returns
 * events since the caller's cursor for free (the connection is already
 * bought); close_stream tears down. The MCP server is a per-session
 * stdio subprocess, so held streams die with the session — every open
 * socket is cancelled on process exit.
 */

import { SseParser, type SseFrame } from "@bolthub/pay";
import type { L402Client } from "@bolthub/pay";
import { type StreamCloseReason } from "./stream-window.js";

export const SUB_BUFFER_MAX_EVENTS = 500;
export const SUB_BUFFER_MAX_CHARS = 1_000_000;
export const SUB_IDLE_REAP_MS = 10 * 60_000;
export const SUB_MAX_WAIT_SECONDS = 25;

export function maxConcurrentStreams(): number {
  const n = parseInt(process.env.BOLTHUB_MAX_STREAMS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

interface BufferedEvent extends SseFrame {
  seq: number;
  ts: number;
}

interface Subscription {
  id: string;
  url: string;
  costSats: number;
  openedAt: number;
  lastReadAt: number;
  /** Next seq to hand this subscription's reader (single-cursor model). */
  cursor: number;
  buffer: BufferedEvent[];
  dropped: number;
  totalEvents: number;
  keepalives: number;
  status: "live" | "closed";
  closeReason?: StreamCloseReason;
  ctrl: AbortController;
  /** The pump's body reader; cancelled directly on close so teardown
   *  never depends on the fetch honoring the abort signal. */
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  /** Resolvers parked by a long-polling read_stream. */
  wakeups: (() => void)[];
  reapTimer?: ReturnType<typeof setTimeout>;
}

export class StreamSubscriptionManager {
  private subs = new Map<string, Subscription>();
  private nextId = 1;
  private readonly idleReapMs: number;
  private exitHooked = false;

  constructor(opts: { idleReapMs?: number } = {}) {
    this.idleReapMs = opts.idleReapMs ?? SUB_IDLE_REAP_MS;
  }

  /** Currently-open (live) subscription count. */
  get openCount(): number {
    return [...this.subs.values()].filter((s) => s.status === "live").length;
  }

  async open(
    url: string,
    l402Client: L402Client,
    opts: { maxCostSats?: number } = {},
  ): Promise<{ streamId: string; costSats: number } | { error: string }> {
    if (this.openCount >= maxConcurrentStreams()) {
      return {
        error:
          `Stream limit reached (${maxConcurrentStreams()} concurrent). ` +
          "close_stream one you no longer need, or raise BOLTHUB_MAX_STREAMS.",
      };
    }

    const ctrl = new AbortController();
    let costSats = 0;
    const resp = await l402Client.request(url, {
      streaming: true,
      signal: ctrl.signal,
      maxCostSats: opts.maxCostSats,
      onPaid: (info) => {
        costSats = info.amount;
      },
    });

    const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (!resp.ok || !contentType.includes("text/event-stream") || !resp.body) {
      ctrl.abort();
      const text = await resp.text().catch(() => "");
      return {
        error: `Endpoint did not open a stream (HTTP ${resp.status}${contentType ? `, ${contentType}` : ""})${text ? `: ${text.slice(0, 300)}` : ""}`,
      };
    }

    const id = `stream-${this.nextId++}`;
    const sub: Subscription = {
      id,
      url,
      costSats,
      openedAt: Date.now(),
      lastReadAt: Date.now(),
      cursor: 0,
      buffer: [],
      dropped: 0,
      totalEvents: 0,
      keepalives: 0,
      status: "live",
      ctrl,
      wakeups: [],
    };
    this.subs.set(id, sub);
    this.armReap(sub);
    this.hookExit();
    void this.pump(sub, resp);
    return { streamId: id, costSats };
  }

  /** Background reader: origin bytes → parser → ring buffer. */
  private async pump(sub: Subscription, resp: Response): Promise<void> {
    const reader = resp.body!.getReader();
    sub.reader = reader;
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          this.markClosed(sub, "origin_closed");
          return;
        }
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.comment) {
            sub.keepalives += 1;
            continue;
          }
          if (frame.event === "payment_required") {
            this.markClosed(sub, "payment_required");
            return;
          }
          sub.buffer.push({ ...frame, seq: sub.totalEvents, ts: Date.now() });
          sub.totalEvents += 1;
          this.trim(sub);
        }
        if (sub.buffer.length > 0) this.wake(sub);
      }
    } catch {
      // Abort (close/reap/exit) or transport failure: closeReason was
      // already set for deliberate closes; anything else is an error.
      if (sub.status === "live") this.markClosed(sub, "error");
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  private trim(sub: Subscription): void {
    if (sub.buffer.length > SUB_BUFFER_MAX_EVENTS) {
      const excess = sub.buffer.length - SUB_BUFFER_MAX_EVENTS;
      sub.buffer.splice(0, excess);
      sub.dropped += excess;
    }
    let chars = sub.buffer.reduce((n, e) => n + e.data.length, 0);
    while (chars > SUB_BUFFER_MAX_CHARS && sub.buffer.length > 1) {
      chars -= sub.buffer[0].data.length;
      sub.buffer.shift();
      sub.dropped += 1;
    }
  }

  private markClosed(sub: Subscription, reason: StreamCloseReason): void {
    if (sub.status === "closed") return;
    sub.status = "closed";
    sub.closeReason = reason;
    sub.ctrl.abort();
    // Also cancel the body reader directly: it resolves the pump's
    // parked read() with done, tearing the origin socket down even
    // when the response body isn't wired to the abort signal.
    sub.reader?.cancel().catch(() => {});
    if (sub.reapTimer) clearTimeout(sub.reapTimer);
    this.wake(sub);
  }

  private wake(sub: Subscription): void {
    const parked = sub.wakeups.splice(0);
    for (const resolve of parked) resolve();
  }

  private armReap(sub: Subscription): void {
    if (sub.reapTimer) clearTimeout(sub.reapTimer);
    sub.reapTimer = setTimeout(() => {
      // An agent that stopped reading has stopped caring; the socket
      // is not free for the seller's node.
      this.markClosed(sub, "aborted");
    }, this.idleReapMs);
    sub.reapTimer.unref?.();
  }

  /**
   * Events since the cursor. With `waitSeconds`, parks until an event
   * arrives or the wait elapses (cheap "wake me when something happens").
   * After a close, returns the terminal summary ONCE, then forgets the id.
   */
  async read(
    id: string,
    waitSeconds = 0,
  ): Promise<
    | { error: string }
    | {
        events: BufferedEvent[];
        dropped: number;
        status: "live" | "closed";
        closeReason?: StreamCloseReason;
        summary: { totalEvents: number; keepalives: number; durationMs: number; costSats: number };
      }
  > {
    const sub = this.subs.get(id);
    if (!sub) {
      return { error: `No such stream "${id}" — it was never opened, or its terminal summary was already read. open_stream to start a new one.` };
    }

    sub.lastReadAt = Date.now();
    if (sub.status === "live") this.armReap(sub);

    const wait = Math.min(Math.max(0, waitSeconds), SUB_MAX_WAIT_SECONDS);
    if (sub.status === "live" && sub.cursor >= sub.totalEvents && wait > 0) {
      // Nothing unread: park until the pump wakes us or the wait elapses.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait * 1000);
        (timer as { unref?: () => void }).unref?.();
        sub.wakeups.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const firstBuffered = sub.totalEvents - sub.buffer.length;
    const startIdx = Math.max(0, sub.cursor - firstBuffered);
    const missed = sub.cursor < firstBuffered ? firstBuffered - sub.cursor : 0;
    const events = sub.buffer.slice(startIdx);
    sub.cursor = sub.totalEvents;

    const result = {
      events,
      dropped: missed,
      status: sub.status,
      closeReason: sub.closeReason,
      summary: {
        totalEvents: sub.totalEvents,
        keepalives: sub.keepalives,
        durationMs: Date.now() - sub.openedAt,
        costSats: sub.costSats,
      },
    };

    // Terminal summary delivered — forget the id.
    if (sub.status === "closed") this.subs.delete(id);
    return result;
  }

  close(id: string):
    | { error: string }
    | { summary: { totalEvents: number; dropped: number; keepalives: number; durationMs: number; costSats: number } } {
    const sub = this.subs.get(id);
    if (!sub) {
      return { error: `No such stream "${id}".` };
    }
    this.markClosed(sub, "aborted");
    this.subs.delete(id);
    return {
      summary: {
        totalEvents: sub.totalEvents,
        dropped: sub.dropped,
        keepalives: sub.keepalives,
        durationMs: Date.now() - sub.openedAt,
        costSats: sub.costSats,
      },
    };
  }

  /** Cancel every open socket. Used by close() teardown and exit hooks. */
  closeAll(): void {
    for (const sub of this.subs.values()) {
      this.markClosed(sub, "aborted");
    }
    this.subs.clear();
  }

  private hookExit(): void {
    if (this.exitHooked) return;
    this.exitHooked = true;
    // stdio subprocess: the client kills us with the session. Cancel
    // held sockets so origins see clean disconnects, then let the
    // default signal behavior proceed.
    process.once("SIGINT", () => this.closeAll());
    process.once("SIGTERM", () => this.closeAll());
    process.once("exit", () => this.closeAll());
  }
}

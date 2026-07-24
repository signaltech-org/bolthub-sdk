/**
 * open_stream / read_stream / close_stream — the Phase B subscription
 * tools (docs/design/mcp-streaming/SPIKE.md §7). Formatting mirrors the
 * windowed reads: JSON-lines events, honest liveness wording for quiet
 * feeds, explicit close reasons.
 */

import { WALLET_ENV_HINT } from "@bolthub/pay";
import type { L402Client, ToolResult } from "@bolthub/pay";
import type { ApiClient } from "./api-client.js";
import {
  StreamSubscriptionManager,
  SUB_MAX_WAIT_SECONDS,
  maxConcurrentStreams,
} from "./stream-subscriptions.js";
import type { StreamCloseReason } from "./stream-window.js";

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function closeReasonLine(reason: StreamCloseReason | undefined): string {
  switch (reason) {
    case "payment_required":
      return "the gateway ended the paid window (event: payment_required); open_stream again to reconnect (new payment)";
    case "origin_closed":
      return "the origin closed the stream";
    case "aborted":
      return "closed (close_stream, idle reap after no reads, or session teardown)";
    case "error":
      return "the connection failed";
    default:
      return "closed";
  }
}

export async function handleOpenStream(
  args: { slug: string; path: string; query_params?: Record<string, string>; max_cost_sats?: number },
  apiClient: ApiClient,
  l402Client: L402Client | undefined,
  manager: StreamSubscriptionManager,
): Promise<ToolResult> {
  if (!l402Client) {
    return text(`Opening a paid stream requires a wallet.\n${WALLET_ENV_HINT}`, true);
  }
  try {
    let url = apiClient.getGatewayUrl(args.slug, args.path);
    if (args.query_params && Object.keys(args.query_params).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args.query_params)) params.set(k, v);
      url = `${url}?${params.toString()}`;
    }

    const result = await manager.open(url, l402Client, {
      maxCostSats: args.max_cost_sats && args.max_cost_sats > 0 ? args.max_cost_sats : undefined,
    });
    if ("error" in result) return text(result.error, true);

    const costLine = result.costSats > 0 ? ` Paid ${result.costSats} sats for this connection.` : "";
    return text(
      `Stream open: ${result.streamId} (${args.slug} ${args.path}).${costLine}\n` +
        `Reading is free from here: read_stream({ stream_id: "${result.streamId}", wait_seconds: 20 }) returns events since your last read, waiting up to wait_seconds if none are buffered. ` +
        `Zero events between reads is normal for event-driven feeds. close_stream when done; idle streams auto-close after 10 minutes without a read.`,
    );
  } catch (err) {
    return text(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

export async function handleReadStream(
  args: { stream_id: string; wait_seconds?: number },
  manager: StreamSubscriptionManager,
): Promise<ToolResult> {
  const result = await manager.read(args.stream_id, args.wait_seconds ?? 0);
  if ("error" in result) return text(result.error, true);

  const lines: string[] = [];
  const secs = (result.summary.durationMs / 1000).toFixed(0);
  const header =
    `[${args.stream_id}] ${result.events.length} new event${result.events.length === 1 ? "" : "s"} · ` +
    `${result.summary.totalEvents} total in ${secs}s · status: ${result.status}`;
  lines.push(header);
  if (result.dropped > 0) {
    lines.push(`[${result.dropped} earlier events were dropped by the buffer — read more often to keep up]`);
  }
  for (const e of result.events) {
    lines.push(JSON.stringify({ ...(e.event ? { event: e.event } : {}), data: tryParse(e.data) }));
  }
  if (result.events.length === 0 && result.status === "live") {
    const liveness = result.summary.keepalives > 0
      ? `connection healthy (${result.summary.keepalives} keep-alives so far)`
      : "connection open";
    lines.push(`[no new events — ${liveness}; the feed is event-driven and currently quiet, which is normal]`);
  }
  if (result.status === "closed") {
    lines.push(
      `[stream ended: ${closeReasonLine(result.closeReason)} — ${result.summary.totalEvents} events over ${secs}s` +
        `${result.summary.costSats > 0 ? `, ${result.summary.costSats} sats paid` : ""}. This id is now forgotten.]`,
    );
  }
  return text(lines.join("\n"));
}

export function handleCloseStream(
  args: { stream_id: string },
  manager: StreamSubscriptionManager,
): ToolResult {
  const result = manager.close(args.stream_id);
  if ("error" in result) return text(result.error, true);
  const s = result.summary;
  const secs = (s.durationMs / 1000).toFixed(0);
  return text(
    `Stream ${args.stream_id} closed: ${s.totalEvents} events over ${secs}s` +
      `${s.dropped > 0 ? ` (${s.dropped} dropped by the buffer)` : ""}` +
      `${s.costSats > 0 ? `, ${s.costSats} sats paid for the connection` : ""}.`,
  );
}

export const STREAM_TOOL_DEFS = [
  {
    name: "open_stream",
    description:
      `Open a live streaming (SSE) endpoint and hold the connection in the background. One Lightning payment buys the connection; read_stream then returns events for free until the stream closes. Use for continuous monitoring ("tell me when a big liquidation happens"); for a one-off taste use call_api with stream_events/stream_seconds instead. At most ${maxConcurrentStreams()} streams can be open at once, and a stream nobody reads for 10 minutes closes itself.`,
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The API slug (e.g. 'btc-intel')" },
        path: { type: "string", description: "The streaming endpoint path (e.g. '/v1/derivatives/liquidations/stream')" },
        query_params: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Query parameters (e.g. { min_size_usd: '100000' } to filter server-side)",
        },
        max_cost_sats: {
          type: "number",
          description: "Maximum sats to pay for the connection. If the invoice exceeds this, nothing is paid.",
        },
      },
      required: ["slug", "path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "read_stream",
    description:
      `Read new events from a stream opened with open_stream. Free (the connection is already paid). Returns events since your previous read; pass wait_seconds (max ${SUB_MAX_WAIT_SECONDS}) to wait for the next event instead of returning immediately — "wake me when something happens". Zero events on a healthy connection is normal for event-driven feeds. After the stream ends, one final read returns the closing summary.`,
    inputSchema: {
      type: "object",
      properties: {
        stream_id: { type: "string", description: "The id returned by open_stream" },
        wait_seconds: {
          type: "number",
          description: `Seconds to wait for a new event when none are buffered (default 0 = return immediately, max ${SUB_MAX_WAIT_SECONDS})`,
        },
      },
      required: ["stream_id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "close_stream",
    description:
      "Close a stream opened with open_stream and get a final summary (events, duration, cost). Closing does not refund the connection payment. Streams also close themselves on gateway limits, on the paid window ending, or after 10 minutes without a read.",
    inputSchema: {
      type: "object",
      properties: {
        stream_id: { type: "string", description: "The id returned by open_stream" },
      },
      required: ["stream_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

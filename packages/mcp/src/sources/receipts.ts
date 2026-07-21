import { exportReceipts } from "@bolthub/pay";
import type { ReceiptStore, ToolResult } from "@bolthub/pay";
import type { SourceTool, ToolSource } from "./source.js";

/**
 * Session receipt export as a first-class tool. Present only when receipts
 * are configured (`receipts` in mcp.json, `--receipts <path|default>`, or
 * `RECEIPTS_PATH`); recording itself happens inside the shared L402Client.
 * Unprefixed like the marketplace meta-tools: it is part of the server's
 * native surface, not a downstream source.
 */
export interface ReceiptsSourceOpts {
  /** Resolved ledger location; shown in output so a path mismatch is visible. */
  ledgerPath?: string;
  /**
   * Recording health from the paying client. Settled payments whose ledger
   * append failed must surface here — a silently missing receipt is missing
   * money history (2026-07-16 smoke finding 4).
   */
  recordingHealth?: () => { count: number; last?: string };
}

export class ReceiptsSource implements ToolSource {
  readonly key = "receipts";
  readonly kind = "receipts" as const;
  readonly namespaced = false;

  constructor(
    private store: ReceiptStore,
    private opts: ReceiptsSourceOpts = {},
  ) {}

  async init(): Promise<void> {}

  /** Non-empty when receipt writes failed this session. */
  private failureWarning(): string {
    const health = this.opts.recordingHealth?.();
    if (!health || health.count === 0) return "";
    return (
      `\nWARNING: ${health.count} receipt write(s) FAILED this session` +
      `${health.last ? ` (last: ${health.last})` : ""} — paid calls are missing from this ledger. ` +
      `Check that the ledger location is writable.`
    );
  }

  listTools(): SourceTool[] {
    return [
      {
        name: "export_receipts",
        description:
          "Export this machine's L402 payment receipts (cryptographic proof-of-payment records: " +
          "invoice, payment hash, preimage, amount, endpoint, timestamp). " +
          "Recording starts when receipts are enabled — payments made before that are never backfilled. " +
          "Use redact to strip preimages for a shareable expense report.",
        inputSchema: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["json", "csv"], description: "Output format (default json)" },
            redact: { type: "boolean", description: "Replace preimages with REDACTED (default false)" },
            from: { type: "string", description: "Only receipts at or after this ISO 8601 time" },
            to: { type: "string", description: "Only receipts at or before this ISO 8601 time" },
          },
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name !== "export_receipts") {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const range: { from?: Date; to?: Date } = {};
    for (const bound of ["from", "to"] as const) {
      const raw = args[bound];
      if (raw === undefined) continue;
      const date = new Date(String(raw));
      if (Number.isNaN(date.getTime())) {
        return {
          content: [{ type: "text", text: `Invalid ${bound}: ${String(raw)} (expected ISO 8601)` }],
          isError: true,
        };
      }
      range[bound] = date;
    }

    const receipts = this.store.list(range);
    const ledger = this.opts.ledgerPath ? ` Ledger: ${this.opts.ledgerPath}.` : "";
    const warning = this.failureWarning();
    if (receipts.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `No receipts recorded (in this range).${ledger} ` +
              `Recording happens at payment time once receipts are enabled; earlier payments are never backfilled. ` +
              `Paid calls made while receipts are configured will appear here.${warning}`,
          },
        ],
      };
    }
    const format = args.format === "csv" ? "csv" : "json";
    const text = exportReceipts(receipts, { format, redact: args.redact === true });
    return { content: [{ type: "text", text: `${receipts.length} receipt(s):${warning}\n${text}` }] };
  }

  async close(): Promise<void> {}
}

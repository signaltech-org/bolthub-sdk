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
export class ReceiptsSource implements ToolSource {
  readonly key = "receipts";
  readonly kind = "receipts" as const;
  readonly namespaced = false;

  constructor(private store: ReceiptStore) {}

  async init(): Promise<void> {}

  listTools(): SourceTool[] {
    return [
      {
        name: "export_receipts",
        description:
          "Export this machine's L402 payment receipts (cryptographic proof-of-payment records: " +
          "invoice, payment hash, preimage, amount, endpoint, timestamp). " +
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
    if (receipts.length === 0) {
      return {
        content: [{ type: "text", text: "No receipts recorded (in this range). Paid calls made while receipts are configured will appear here." }],
      };
    }
    const format = args.format === "csv" ? "csv" : "json";
    const text = exportReceipts(receipts, { format, redact: args.redact === true });
    return { content: [{ type: "text", text: `${receipts.length} receipt(s):\n${text}` }] };
  }

  async close(): Promise<void> {}
}

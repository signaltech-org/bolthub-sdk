import type { Receipt } from "./receipt-store";

/**
 * Pure receipt serialization (no Node dependencies — safe for the browser
 * entry, unlike the file store). Schema and column order:
 * docs/design/agent-features/SPIKE-8-receipt-schema.md.
 */

/** CSV column order — the Receipt field order from SPIKE-8. */
const CSV_COLUMNS = [
  "receipt_v",
  "ts",
  "resource",
  "method",
  "amount_sats",
  "payment_hash",
  "preimage",
  "invoice",
  "outcome",
] as const;

function csvQuote(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Options for {@link exportReceipts}. */
export interface ExportReceiptsOptions {
  /** `json` (default): pretty-printed array. `csv`: RFC 4180, SPIKE-8 column order. */
  format?: "json" | "csv";
  /**
   * Replace each preimage with `REDACTED`. Keeps the expense record but
   * removes the proof-of-payment (and any residual credential value);
   * verifiers report redacted receipts as "redacted", not "invalid".
   */
  redact?: boolean;
}

/** Serialize receipts for an expense report. Pure; reads nothing. */
export function exportReceipts(receipts: Receipt[], opts: ExportReceiptsOptions = {}): string {
  const rows = opts.redact
    ? receipts.map((r) => ({ ...r, preimage: "REDACTED" }))
    : receipts;
  if ((opts.format ?? "json") === "json") {
    return JSON.stringify(rows, null, 2);
  }
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(CSV_COLUMNS.map((c) => csvQuote(r[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

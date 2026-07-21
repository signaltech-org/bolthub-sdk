/// <reference types="node" />
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

/**
 * Preimage receipts (schema v1 — see
 * docs/design/agent-features/SPIKE-8-receipt-schema.md). Every settled L402
 * payment yields a `(invoice, payment_hash, preimage)` triple that proves
 * the payment to anyone, offline. A receipt records that triple with the
 * spend context; a receipt file is a verifiable expense report for agent
 * spend.
 *
 * Opt-in by construction: no store configured on the client, nothing
 * written. This module is Node-only (main entry, not the browser entry),
 * like the session store.
 */

/** One paid call. Field order is also the CSV column order. */
export interface Receipt {
  /** Schema version; 1. Additive fields don't bump it. */
  receipt_v: 1;
  /** ISO 8601 UTC, when the payment settled. */
  ts: string;
  /** Request URL (HTTP) or TPP resource id (MCP). */
  resource: string;
  /** HTTP method; `TOOL` for TPP tool calls. */
  method: string;
  /** Sats paid, as counted against the budget. */
  amount_sats: number;
  /** Hex; equals sha256(preimage) and the hash in the BOLT11 invoice. */
  payment_hash: string;
  /** Hex proof of payment; `REDACTED` after redacted export. */
  preimage: string;
  /** The BOLT11 invoice that was paid. */
  invoice: string;
  /**
   * Last-observed payment disposition (`charged`, `reverted`,
   * `refunded_to_balance`, or `unknown` when the gateway didn't say).
   * A reverted receipt superseded by a successful free retry appears
   * alongside the retry's own receipt: group by `payment_hash`; the money
   * truth is one settled payment per hash.
   */
  outcome: string;
}

/** Pluggable sink for payment receipts. */
export interface ReceiptStore {
  append(receipt: Receipt): void;
  list(range?: { from?: Date; to?: Date }): Receipt[];
}

/** Fill `payment_hash` from the preimage when the caller didn't know it. */
export function completeReceipt(receipt: Receipt): Receipt {
  if (receipt.payment_hash) return receipt;
  return {
    ...receipt,
    payment_hash: createHash("sha256")
      .update(Buffer.from(receipt.preimage, "hex"))
      .digest("hex"),
  };
}

function inRange(r: Receipt, range?: { from?: Date; to?: Date }): boolean {
  if (!range) return true;
  const t = Date.parse(r.ts);
  if (range.from && t < range.from.getTime()) return false;
  if (range.to && t > range.to.getTime()) return false;
  return true;
}

// Serialization lives in ./receipt-export (pure, browser-safe); this module
// keeps the Node-only stores.

/** Keeps receipts in memory; for tests and short-lived scripts. */
export class InMemoryReceiptStore implements ReceiptStore {
  private receipts: Receipt[] = [];

  append(receipt: Receipt): void {
    this.receipts.push(completeReceipt(receipt));
  }

  list(range?: { from?: Date; to?: Date }): Receipt[] {
    return this.receipts.filter((r) => inRange(r, range));
  }
}

const DEFAULT_DIR = join(homedir(), ".bolthub");
const DEFAULT_FILE = "receipts.jsonl";

/**
 * Appends receipts to a JSONL file (`~/.bolthub/receipts.jsonl` by
 * default), one JSON object per line, created `0600`. Appends are
 * single-write; a receipt is money history, so append failures THROW
 * rather than silently dropping the record (same stance as the session
 * store's persist).
 */
export class FileReceiptStore implements ReceiptStore {
  private filePath: string;

  /** @param filePath - Custom path. Defaults to `~/.bolthub/receipts.jsonl`. */
  constructor(filePath?: string) {
    this.filePath = filePath ?? join(DEFAULT_DIR, DEFAULT_FILE);
  }

  /** Where this ledger lives — diagnostics surfaces (export empty-states)
   *  print it so a path/scoping mismatch is visible on sight. */
  get path(): string {
    return this.filePath;
  }

  append(receipt: Receipt): void {
    const dir = dirname(this.filePath);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Directory already exists
    }
    appendFileSync(this.filePath, JSON.stringify(completeReceipt(receipt)) + "\n", {
      mode: 0o600,
    });
  }

  list(range?: { from?: Date; to?: Date }): Receipt[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const out: Receipt[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Receipt;
        if (r.receipt_v === 1 && inRange(r, range)) out.push(r);
      } catch {
        // A torn or foreign line is skipped, never fatal: the rest of the
        // ledger stays readable.
      }
    }
    return out;
  }
}

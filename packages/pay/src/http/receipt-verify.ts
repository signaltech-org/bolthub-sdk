/// <reference types="node" />
import { createHash } from "crypto";
import type { Receipt } from "./receipt-store";
import { bolt11PaymentHash } from "./bolt11-hash";
import { bolt11AmountSats } from "./invoice";

/**
 * Offline receipt verification (SPIKE-8 rules). No bolthub service in the
 * loop: anyone holding the receipt can run the same checks.
 *
 *   1. sha256(preimage) == payment_hash            (proof of payment)
 *   2. payment_hash == hash committed in the BOLT11 (proof it paid THIS invoice)
 *   3. amount_sats == invoice amount, when the invoice carries one
 *
 * Statuses: `valid` (all checks pass), `redacted` (preimage stripped by a
 * redacted export — an expense record, not a proof; by design), `invalid`
 * (a check failed; see reasons), `unverifiable` (fields missing).
 */
export interface ReceiptVerifyResult {
  status: "valid" | "redacted" | "invalid" | "unverifiable";
  reasons: string[];
}

export function verifyReceipt(receipt: Receipt): ReceiptVerifyResult {
  if (receipt.preimage === "REDACTED") {
    return { status: "redacted", reasons: ["preimage redacted by export"] };
  }
  if (!receipt.preimage || !receipt.payment_hash || !receipt.invoice) {
    const missing = [
      !receipt.preimage && "preimage",
      !receipt.payment_hash && "payment_hash",
      !receipt.invoice && "invoice",
    ].filter(Boolean);
    return { status: "unverifiable", reasons: [`missing: ${missing.join(", ")}`] };
  }

  const reasons: string[] = [];

  let preimageHash: string | null = null;
  if (/^[0-9a-fA-F]+$/.test(receipt.preimage) && receipt.preimage.length % 2 === 0) {
    preimageHash = createHash("sha256")
      .update(Buffer.from(receipt.preimage, "hex"))
      .digest("hex");
  }
  if (preimageHash === null) {
    reasons.push("preimage is not valid hex");
  } else if (preimageHash !== receipt.payment_hash.toLowerCase()) {
    reasons.push("sha256(preimage) does not match payment_hash");
  }

  const invoiceHash = bolt11PaymentHash(receipt.invoice);
  if (invoiceHash === null) {
    reasons.push("invoice does not decode (bad bech32 or no payment hash)");
  } else if (invoiceHash !== receipt.payment_hash.toLowerCase()) {
    reasons.push("payment_hash does not match the hash committed in the invoice");
  }

  const invoiceAmount = bolt11AmountSats(receipt.invoice);
  if (invoiceAmount !== null && invoiceAmount !== receipt.amount_sats) {
    reasons.push(
      `amount_sats (${receipt.amount_sats}) differs from the invoice amount (${invoiceAmount})`,
    );
  }

  return reasons.length === 0 ? { status: "valid", reasons: [] } : { status: "invalid", reasons };
}

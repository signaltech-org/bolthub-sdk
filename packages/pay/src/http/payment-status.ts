/**
 * Payment-status taxonomy emitted by bolthub gateways when
 * `GATEWAY_PAYMENT_STATUS_HEADERS` is enabled on the gateway.
 *
 * `X-Bolthub-Payment` states what happened to the request's money;
 * `X-Bolthub-Payment-Code` classifies failures. `upstream_failed_retryable`
 * is the load-bearing signal: the payment layer already gave the money back
 * (per_request: the same preimage redeems again; session models: the
 * deduction returned to the balance), so re-sending the identical request
 * with the held credential costs nothing.
 *
 * Older gateways and gateways with the flag off emit neither header —
 * {@link readPaymentStatus} returns `null` and callers must not assume
 * anything about the payment.
 */

export const PAYMENT_HEADER = "X-Bolthub-Payment";
export const PAYMENT_CODE_HEADER = "X-Bolthub-Payment-Code";

/**
 * What happened to this request's money. The `(string & {})` arm keeps the
 * union forward-compatible: a newer gateway may emit states this SDK
 * version doesn't know yet.
 */
export type PaymentState =
  | "charged"
  | "reverted"
  | "refunded_to_balance"
  | "not_charged"
  | (string & {});

/** Machine-readable failure class accompanying a non-charged outcome. */
export type PaymentCode =
  | "upstream_failed_retryable"
  | "upstream_rejected"
  | "payment_failed"
  | "token_revoked"
  | "bundle_expired"
  | "refunded_monetary"
  | (string & {});

/** Parsed payment outcome of one gateway response. */
export interface PaymentStatus {
  state: PaymentState;
  code?: PaymentCode;
}

/**
 * Read the payment-status headers off a response. Returns `null` when the
 * gateway did not emit them (flag off, older gateway, or a non-bolthub
 * server) — in that case nothing may be assumed about the payment.
 */
export function readPaymentStatus(headers: Headers): PaymentStatus | null {
  const state = headers.get(PAYMENT_HEADER);
  if (!state) return null;
  const code = headers.get(PAYMENT_CODE_HEADER);
  return { state, code: code ?? undefined };
}

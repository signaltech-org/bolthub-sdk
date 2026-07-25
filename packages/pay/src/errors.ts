/**
 * Buyer-side payment errors, shared by {@link Budget}, `ToolClient`, and the
 * HTTP `L402Client`. Kept in their own module so `budget.ts` and
 * `buyer/client.ts` can both throw them without importing each other.
 */

/** Base error for buyer-side payment failures. */
export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

/** Thrown when a payment would exceed the configured budget. */
export class PaymentBudgetError extends PaymentError {
  constructor(message: string) {
    super(message);
    this.name = "PaymentBudgetError";
  }
}

/**
 * Translate a raw wallet/node payment error into something an agent can
 * act on (smoke-test finding M5). The raw message is preserved — callers
 * and logs still see exactly what the wallet said — with the actionable
 * reading appended for the common failure classes.
 *
 * NWC wallets often return a generic message ("Problem sending payment")
 * where only the NIP-47 error CODE carries the cause, so the code — read
 * duck-typed off the error, since this package cannot depend on
 * `@getalby/sdk` — is classified first and always quoted in the output
 * (2026-07-25 smoke finding F11: six different operator actions were
 * indistinguishable from the bare message).
 */
export function describePaymentFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "Payment failed");
  const rawCode = (err as { code?: unknown } | null | undefined)?.code;
  const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode.toUpperCase() : undefined;
  const quoted = code ? `${raw} [wallet error code: ${code}]` : raw;

  switch (code) {
    case "INSUFFICIENT_BALANCE":
      return `${quoted} — the spending wallet doesn't have enough balance (or outbound channel capacity) for this amount plus routing fees. Top up the wallet, then retry.`;
    case "RESTRICTED":
      return `${quoted} — this wallet connection is not permitted to pay invoices (a receive-only NWC connection string is a common default). Re-create the connection with the pay_invoice permission and restart the process so it picks up the new connection string.`;
    case "UNAUTHORIZED":
      return `${quoted} — the wallet rejected this connection as unauthorized. The connection string may have been revoked or replaced; create a fresh one and restart the process so it picks it up.`;
    case "QUOTA_EXCEEDED":
      return `${quoted} — this wallet connection's own spending budget is used up (separate from the session budget here). Raise or reset the connection's budget on the wallet side.`;
    case "RATE_LIMITED":
      return `${quoted} — the wallet is rate-limiting this connection. Wait a moment and retry.`;
    case "NOT_IMPLEMENTED":
      return `${quoted} — the wallet does not support paying invoices over this connection (pay_invoice is not implemented). Use a different wallet or connection type.`;
    case "PAYMENT_FAILED":
      return `${quoted} — the wallet tried to send and the Lightning payment failed. Common causes: no route to the destination, not enough outbound channel liquidity (on-chain funds don't count), or the destination is offline. Check the spending wallet's channels and the wallet's own logs.`;
  }
  if (/reply timeout|publish timeout|failed to connect/i.test(raw)) {
    return `${quoted} — the wallet did not respond over its relay/transport: it may be offline, unreachable, or the relay may be down. Check that the wallet is running and reachable, then retry.`;
  }
  if (/unknown destination|unable to find a path|no[_ ]?route|not enough capacity/i.test(raw)) {
    return `${quoted} — the destination (the seller's wallet) can't be reached on the Lightning graph. It likely has no channels or no inbound liquidity (common for a brand-new node), or is offline.`;
  }
  if (/self[- ]?payment|pay.*own invoice|to self/i.test(raw)) {
    return `${quoted} — the spending wallet and the invoice issuer appear to be the same wallet. Lightning cannot pay self-issued invoices; use a different spending wallet.`;
  }
  if (/insufficient|not enough (balance|funds)/i.test(raw)) {
    return `${quoted} — the spending wallet doesn't have enough balance or outbound capacity for this amount.`;
  }
  if (/expired|expiry/i.test(raw)) {
    return `${quoted} — the invoice appears to have expired before the payment settled. Retry the call to get a fresh invoice.`;
  }
  // INTERNAL and OTHER carry no classification of their own; the quoted
  // code plus this pointer is everything the wallet disclosed.
  if (code) {
    return `${quoted} — the wallet reported a generic failure with no machine-readable cause. Check the spending wallet's balance, channel liquidity, and its own logs (the wallet-side diagnostics surface shows what this connection can do).`;
  }
  return raw;
}

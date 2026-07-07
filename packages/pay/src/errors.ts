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

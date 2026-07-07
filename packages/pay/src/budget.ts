/**
 * A per-asset spending budget with synchronous reserve/rollback.
 *
 * Extracted from `ToolClient`'s internal accounting so several payment paths
 * can share ONE pool: pass the same `Budget` to a `ToolClient` (MCP-wire
 * payments) and an `L402Client` (HTTP-402 payments) and neither can spend
 * past `maxTotal`, even under concurrent calls — {@link Budget.reserve} is
 * synchronous, so it must be called before any `await` on the payment path,
 * and rolled back if the payment then fails.
 */

import { PaymentBudgetError } from "./errors";

export interface BudgetLimits {
  /** Per-asset lifetime spend ceiling, e.g. `{ sat: 10_000 }`. Unset asset = unlimited. */
  maxTotal?: Partial<Record<string, number>>;
  /** Per-asset per-call ceiling. Unset asset = unlimited. */
  maxPerCall?: Partial<Record<string, number>>;
}

export class Budget {
  private readonly spent: Record<string, number> = {};

  constructor(private readonly limits: BudgetLimits = {}) {}

  /** Total reserved-and-kept so far in `asset`. */
  spentFor(asset: string): number {
    return this.spent[asset] ?? 0;
  }

  /** Remaining headroom in `asset` (`Infinity` if no `maxTotal` configured). */
  remainingFor(asset: string): number {
    const max = this.limits.maxTotal?.[asset];
    return max === undefined ? Infinity : Math.max(0, max - this.spentFor(asset));
  }

  /** The configured per-call ceiling for `asset` (`Infinity` if none). */
  perCallFor(asset: string): number {
    return this.limits.maxPerCall?.[asset] ?? Infinity;
  }

  /**
   * Pure check; returns the denial reason, or `undefined` when the charge
   * fits. `perCallOverride` tightens (never loosens) the per-call ceiling for
   * this one call — e.g. a caller-supplied `max_cost_sats`.
   */
  check(asset: string, amount: number, perCallOverride?: number): string | undefined {
    if (!Number.isFinite(amount) || amount <= 0) return "invalid offer amount";
    const perCall = Math.min(this.perCallFor(asset), perCallOverride ?? Infinity);
    if (amount > perCall) return "exceeds per-call cap";
    const max = this.limits.maxTotal?.[asset];
    if (max !== undefined && this.spentFor(asset) + amount > max) return "exceeds total budget";
    return undefined;
  }

  /**
   * SYNCHRONOUS reserve — throws {@link PaymentBudgetError} when the charge
   * doesn't fit. Call before the payment `await`; on payment failure, return
   * the reservation with {@link rollback}.
   */
  reserve(asset: string, amount: number, perCallOverride?: number): void {
    const denial = this.check(asset, amount, perCallOverride);
    if (denial) throw new PaymentBudgetError(`Offer ${amount} ${asset} ${denial}`);
    this.spent[asset] = this.spentFor(asset) + amount;
  }

  /** Return a reservation after a failed payment. */
  rollback(asset: string, amount: number): void {
    this.spent[asset] = this.spentFor(asset) - amount;
  }
}

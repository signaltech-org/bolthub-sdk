/**
 * The buyer client: call any tool safely, and settle payment transparently
 * when one is required.
 *
 * `ToolClient` calls a tool; free tools pass through untouched. If the result
 * is a `payment_required` challenge, it picks an offer it has a
 * {@link PaymentPayer} for, checks the budget, pays, and retries the call with
 * the proof in `_meta["ai.bolthub/payment"]`. It is the symmetric counterpart
 * of the seller-side `paywall()`. (Known as `PayingClient` before 0.3.0; the
 * old name remains as a deprecated alias.)
 *
 * Budget is per asset: `maxTotal.sat`, `maxPerCall.sat`, etc. The reservation is
 * taken synchronously before the pay await, so concurrent calls can't both pass
 * the check and overspend.
 */

import { PAYMENT_META_KEY } from "../paywall";
import type { Offer, PaymentChallenge, PaymentPayer, ToolResult } from "../types";

export type PayStage = "calling" | "paying" | "retrying";

export interface ToolClientOptions {
  /** Payers in preference order. The first that matches an offer and fits the budget wins. */
  payers: PaymentPayer[];
  /** Per-asset lifetime spend ceiling, e.g. `{ sat: 10_000 }`. Unset asset = unlimited. */
  maxTotal?: Partial<Record<string, number>>;
  /** Per-asset per-call ceiling. Unset asset = unlimited. */
  maxPerCall?: Partial<Record<string, number>>;
  /** Called after a successful payment, before the retry. */
  onPaid?: (info: { scheme: string; amount: number; asset: string; resource: string }) => void;
  /** Lifecycle callback. */
  onStage?: (stage: PayStage) => void;
}

/** Minimal shape of an MCP client's `callTool` — the SDK's client satisfies it. */
export interface McpCallToolClient {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<unknown>;
}

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

/** Thrown when every offered rail exceeds the configured budget. */
export class PaymentBudgetError extends PaymentError {
  constructor(message: string) {
    super(message);
    this.name = "PaymentBudgetError";
  }
}

/** Extract a `payment_required` challenge from a tool result, if present. */
export function getPaymentChallenge(result: ToolResult): PaymentChallenge | undefined {
  const raw = result?._meta?.[PAYMENT_META_KEY] as PaymentChallenge | undefined;
  if (raw && raw.status === "payment_required" && Array.isArray(raw.offers)) return raw;
  return undefined;
}

export class ToolClient {
  private readonly payers: PaymentPayer[];
  private readonly spent: Record<string, number> = {};

  constructor(private readonly options: ToolClientOptions) {
    if (!options.payers || options.payers.length === 0) {
      throw new Error("PayingClient: at least one payer is required");
    }
    this.payers = options.payers;
  }

  /** Total spent so far in `asset`. */
  spentFor(asset: string): number {
    return this.spent[asset] ?? 0;
  }

  /** Remaining budget in `asset` (`Infinity` if none configured). */
  remainingFor(asset: string): number {
    const max = this.options.maxTotal?.[asset];
    return max === undefined ? Infinity : Math.max(0, max - this.spentFor(asset));
  }

  /**
   * Run a tool call through the pay-and-retry loop. `caller(meta)` performs the
   * call, merging `meta` into the request `_meta`. Returns the final result;
   * if no configured payer matches an offered rail, returns the unpaid
   * challenge result so the caller can decide.
   */
  async call(caller: (meta?: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
    this.options.onStage?.("calling");
    const first = await caller();

    const challenge = getPaymentChallenge(first);
    if (!challenge) return first; // free tool, a real result, or a non-payment error

    const selected = this.selectOffer(challenge); // throws PaymentBudgetError if matched-but-unaffordable
    if (!selected) return first; // no payer for any offered rail
    const { payer, offer } = selected;

    this.reserve(offer); // synchronous budget gate, before the await
    let proof: string;
    this.options.onStage?.("paying");
    try {
      ({ proof } = await payer.pay(offer));
    } catch (err) {
      this.rollback(offer);
      throw new PaymentError(
        `Failed to pay ${offer.amount} ${offer.asset} via ${payer.scheme}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    this.options.onPaid?.({
      scheme: payer.scheme,
      amount: Number(offer.amount),
      asset: String(offer.asset),
      resource: challenge.resource,
    });
    this.options.onStage?.("retrying");
    return caller({ [PAYMENT_META_KEY]: { scheme: payer.scheme, proof } });
  }

  /** Convenience over {@link call} for an MCP client's `callTool`. */
  async callTool(client: McpCallToolClient, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.call((meta) => client.callTool({ name, arguments: args, _meta: meta }) as Promise<ToolResult>);
  }

  /** Pick the first payer (in preference order) with a matching, affordable offer. */
  private selectOffer(challenge: PaymentChallenge): { payer: PaymentPayer; offer: Offer } | undefined {
    let matchedButUnaffordable = false;
    for (const payer of this.payers) {
      const offer = challenge.offers.find((o) => o.scheme === payer.scheme);
      if (!offer) continue;
      if (this.budgetDenial(offer)) {
        matchedButUnaffordable = true;
        continue; // a cheaper rail later in the list may still fit
      }
      return { payer, offer };
    }
    if (matchedButUnaffordable) {
      throw new PaymentBudgetError(
        `All offered rails exceed the budget for their asset (offers: ${challenge.offers
          .map((o) => `${o.amount} ${o.asset}`)
          .join(", ")})`,
      );
    }
    return undefined;
  }

  /** Pure budget check; returns a reason string when the offer can't be paid. */
  private budgetDenial(offer: Offer): string | undefined {
    const asset = String(offer.asset);
    const amount = Number(offer.amount);
    if (!Number.isFinite(amount) || amount <= 0) return "invalid offer amount";
    const perCall = this.options.maxPerCall?.[asset];
    if (perCall !== undefined && amount > perCall) return "exceeds per-call cap";
    const max = this.options.maxTotal?.[asset];
    if (max !== undefined && this.spentFor(asset) + amount > max) return "exceeds total budget";
    return undefined;
  }

  private reserve(offer: Offer): void {
    const denial = this.budgetDenial(offer);
    if (denial) throw new PaymentBudgetError(`Offer ${offer.amount} ${offer.asset} ${denial}`);
    const asset = String(offer.asset);
    this.spent[asset] = this.spentFor(asset) + Number(offer.amount);
  }

  private rollback(offer: Offer): void {
    const asset = String(offer.asset);
    this.spent[asset] = this.spentFor(asset) - Number(offer.amount);
  }
}

/** @deprecated Renamed to {@link ToolClient} in 0.3.0; this alias will be removed in 1.0. */
export const PayingClient = ToolClient;
/** @deprecated Renamed to {@link ToolClient} in 0.3.0. */
export type PayingClient = ToolClient;
/** @deprecated Renamed to {@link ToolClientOptions} in 0.3.0. */
export type PayingClientOptions = ToolClientOptions;

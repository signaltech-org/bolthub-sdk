/**
 * The shared payment services: ONE `Budget` that both payment paths draw
 * from —
 *
 *   - gateway / marketplace tools settle HTTP 402 challenges via `L402Client`
 *   - downstream MCP tools settle TPP `_meta` challenges via `ToolClient`
 *
 * Reservations inside `Budget` are synchronous, so concurrent calls across
 * DIFFERENT sources can never jointly overspend `budget.sat`.
 *
 * With no wallet both clients are absent; sources fall back to unpaid
 * behavior (free tools work, paid ones surface the challenge).
 */

import { Budget, FileSessionStore, L402Client, ToolClient, l402Payer } from "@bolthub/pay";
import type { WalletAdapter } from "@bolthub/pay";
import type { ResolvedConfig } from "./config";
import { audit } from "./telemetry";

export interface PaymentServices {
  budget: Budget;
  wallet?: WalletAdapter;
  /** Present iff a wallet is configured. */
  l402Client?: L402Client;
  /** Present iff a wallet is configured (ToolClient requires ≥1 payer). */
  toolClient?: ToolClient;
}

export function createPaymentServices(
  config: ResolvedConfig,
  wallet: WalletAdapter | undefined,
): PaymentServices {
  const budget = new Budget({ maxTotal: config.budget, maxPerCall: config.maxPerCall });
  if (!wallet) return { budget };

  const l402Client = new L402Client({
    wallet,
    budget,
    timeoutMs: 45_000,
    sessionStore: new FileSessionStore(),
    onPaid: audit,
  });
  const toolClient = new ToolClient({
    payers: [l402Payer({ wallet })],
    budget,
    onPaid: audit,
  });
  return { budget, wallet, l402Client, toolClient };
}

/**
 * `@bolthub/pay` — the bolthub payments SDK, both sides of the sale.
 *
 * Seller side: `createPaywall` + rails implement the bolthub Tool Payment
 * Profile (TPP) for MCP tools and HTTP endpoints. Lightning-only: settles
 * over the L402 rail behind the {@link PaymentRail} interface. See
 * `docs/tool-payment-profile-v0.md` in this package for the wire format.
 *
 * Buyer side: `ToolClient` pays TPP challenges on the MCP wire; `L402Client`
 * pays HTTP 402 challenges (absorbed from `@bolthub/agent` in 0.4.0), both
 * backed by the same wallet adapters and — optionally — one shared {@link Budget}.
 */

export { createPaywall, PAYMENT_META_KEY, SPEC_VERSION } from "./paywall";
export type { CreatePaywallOptions, Paywall, PaywallToolOptions } from "./paywall";

export { l402Rail } from "./rails/l402";
export type { L402RailOptions } from "./rails/l402";

export { facilitatorRail, httpFacilitator } from "./rails/facilitator";
export type {
  FacilitatorRailOptions,
  HttpFacilitatorOptions,
  FacilitatorTransport,
  MintRequest,
  VerifyRequest,
} from "./rails/facilitator";

export { ToolClient, PayingClient, PaymentError, PaymentBudgetError, getPaymentChallenge } from "./buyer/client";
export type { ToolClientOptions, PayingClientOptions, McpCallToolClient, PayStage } from "./buyer/client";

export { l402Payer } from "./payers/l402";
export type { L402PayerOptions, L402PayerWallet } from "./payers/l402";

export { signL402Token, verifyL402Token, verifyPreimage, sha256Hex, randomPreimage } from "./token";
export type { L402TokenPayload, VerifyTokenResult } from "./token";

export type {
  Price,
  ResourceRef,
  BillingModel,
  PaymentAdvertisement,
  Offer,
  PaymentChallenge,
  PaymentProof,
  VerifyResult,
  VerifyContext,
  PaymentRail,
  PaymentPayer,
  InvoiceProvider,
  ToolResult,
  ToolExtra,
  ToolHandler,
} from "./types";

// ── Shared budget (one pool across ToolClient + L402Client) ────────────────

export { Budget } from "./budget";
export type { BudgetLimits } from "./budget";

// ── HTTP (L402) buyer client — absorbed from @bolthub/agent in 0.4.0 ───────

export {
  L402Client,
  L402Error,
  L402BudgetError,
  L402TimeoutError,
  L402PaymentError,
} from "./http/client";
export type {
  WalletAdapter,
  L402ClientOptions,
  L402Challenge,
  L402RequestOptions,
} from "./http/types";
export { FileSessionStore } from "./http/session-store";
export type { SessionStore, SessionData } from "./http/session-store";
export { attenuate } from "./http/delegate";
export type { AttenuateOptions } from "./http/delegate";

// ── Wallet adapters ─────────────────────────────────────────────────────────

export { LndWallet } from "./wallets/lnd";
export type { LndWalletOptions } from "./wallets/lnd";
export { LnbitsWallet } from "./wallets/lnbits";
export type { LnbitsWalletOptions } from "./wallets/lnbits";
export { NwcWallet } from "./wallets/nwc";
export type { NwcConnection } from "./wallets/nwc";
export { PhoenixdWallet } from "./wallets/phoenixd";
export type { PhoenixdWalletOptions } from "./wallets/phoenixd";
export { WebLnWallet, isWebLnAvailable } from "./wallets/webln";
export { walletFromEnv, WALLET_ENV_HINT } from "./wallets/from-env";
export type { WalletFromEnvOptions } from "./wallets/from-env";

import { L402Client as _L402Client } from "./http/client";
import type { L402ClientOptions as _L402ClientOptions } from "./http/types";

/** Shorthand factory that creates and returns a new {@link L402Client} instance. */
export function createL402Client(options: _L402ClientOptions): _L402Client {
  return new _L402Client(options);
}

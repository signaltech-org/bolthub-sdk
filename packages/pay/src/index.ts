/**
 * `@bolthub/pay` — charge for an MCP tool (or HTTP endpoint) in a few lines.
 *
 * Seller side of the bolthub Tool Payment Profile (TPP). Lightning-only: settles
 * over the L402 rail behind the {@link PaymentRail} interface. See
 * `docs/tool-payment-profile-v0.md` in this package for the wire format.
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

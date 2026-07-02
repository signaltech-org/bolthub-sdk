/**
 * `@bolthub/pay` — charge for an MCP tool (or HTTP endpoint) in a few lines.
 *
 * Seller side of the bolthub Tool Payment Profile (TPP). Rail-agnostic: ships
 * the L402 (Lightning) rail today; x402 (stablecoin) drops in behind the same
 * {@link PaymentRail} interface. See `docs/tool-payment-profile-v0.md` in this
 * package for the wire format.
 */

export { createPaywall, PAYMENT_META_KEY, SPEC_VERSION } from "./paywall";
export type { CreatePaywallOptions, Paywall, PaywallToolOptions } from "./paywall";

export { l402Rail } from "./rails/l402";
export type { L402RailOptions } from "./rails/l402";

export { x402Rail } from "./rails/x402";
export type {
  X402RailOptions,
  FacilitatorClient,
  X402Requirements,
  X402PaymentPayload,
} from "./rails/x402";

export { x402Facilitator } from "./x402/facilitator-client";
export type { X402FacilitatorOptions } from "./x402/facilitator-client";

export { eip3009Signer } from "./x402/signer";
export type { Eip3009SignerOptions, Eip712Account } from "./x402/signer";

export { facilitatorRail, httpFacilitator } from "./rails/facilitator";
export type {
  FacilitatorRailOptions,
  HttpFacilitatorOptions,
  FacilitatorTransport,
  MintRequest,
  VerifyRequest,
} from "./rails/facilitator";

export { PayingClient, PaymentError, PaymentBudgetError, getPaymentChallenge } from "./buyer/client";
export type { PayingClientOptions, McpCallToolClient, PayStage } from "./buyer/client";

export { l402Payer } from "./payers/l402";
export type { L402PayerOptions, L402PayerWallet } from "./payers/l402";

export { x402Payer } from "./payers/x402";
export type { X402PayerOptions, X402Signer } from "./payers/x402";

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

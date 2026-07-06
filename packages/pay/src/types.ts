/**
 * Core types for the bolthub Tool Payment Profile (TPP).
 *
 * See `docs/specs/tool-payment-profile-v0.md` for the wire spec these mirror.
 * TPP is rail-agnostic: a {@link PaymentRail} knows how to mint an {@link Offer}
 * and verify a {@link PaymentProof}; the paywall core never sees rail-specific
 * bytes.
 */

/** A price expressed in the smallest unit of an asset (sats, or token base units). */
export interface Price {
  /** Integer amount in the asset's smallest unit (e.g. sats). */
  amount: number;
  /** Asset identifier. Defaults to `"sat"`. */
  asset?: string;
}

/** Stable identifier for the thing being paid for (an MCP tool or HTTP endpoint). */
export type ResourceRef = string;

/** Billing model. v0 normative value is `"per_call"`. */
export type BillingModel = "per_call" | "per_kb" | "prepaid";

/** Discovery-time price advertisement (advisory; carries no commitment). */
export interface PaymentAdvertisement {
  version: string;
  price: Required<Price>;
  model: BillingModel;
  rails: string[];
}

/**
 * One rail's concrete instructions to pay a {@link Price}. `scheme`, `amount`,
 * and `asset` are common; everything else (invoice, token, payTo, …) is
 * rail-specific and carried through the open index signature.
 */
export interface Offer {
  scheme: string;
  amount: number;
  asset: string;
  [field: string]: unknown;
}

/** "Payment required" — one or more {@link Offer}s for a price, scoped to a resource. */
export interface PaymentChallenge {
  status: "payment_required";
  version: string;
  price: Required<Price>;
  resource: ResourceRef;
  offers: Offer[];
  /** Unix ms; the earliest offer expiry. */
  expiresAt: number;
}

/** Opaque, rail-scoped proof of payment supplied by the buyer on retry. */
export interface PaymentProof {
  /** Must match the {@link PaymentRail.scheme} that minted the offer. */
  scheme: string;
  /** Rail-defined proof string (for L402: `<token>:<preimageHex>`). */
  proof: string;
}

/** Outcome of verifying a {@link PaymentProof} against a rail. */
export interface VerifyResult {
  ok: boolean;
  /** Reason when `!ok` — safe to surface to the caller; never leaks secrets. */
  reason?: string;
  /** The resource the proof was scoped to, when `ok`. */
  resource?: ResourceRef;
  /** Amount settled, when the rail can report it. */
  amount?: number;
}

/** Context a rail needs to verify a proof: the resource called and the price offered. */
export interface VerifyContext {
  /** Resource the call targets; a proof minted for another resource MUST be rejected. */
  resource: ResourceRef;
  /** The price (and asset) this rail offered — what the proof must satisfy. */
  price: Required<Price>;
}

/**
 * A settlement rail. Implement this to add a rail without touching the paywall
 * core. The two halves are symmetric: {@link createOffer} mints the challenge a
 * buyer pays; {@link verify} checks the proof they return.
 */
export interface PaymentRail {
  /** Scheme id, e.g. `"l402"`. Must match {@link PaymentProof.scheme}. */
  readonly scheme: string;
  /**
   * Assets this rail can settle, e.g. `["sat"]`. The paywall uses this to match
   * one of a tool's prices to a rail.
   */
  readonly assets: string[];
  /** Build a concrete {@link Offer} for `price`, bound to `resource`. */
  createOffer(price: Required<Price>, resource: ResourceRef): Promise<Offer>;
  /** Verify a buyer's `proof` string was minted for `ctx.resource` at `ctx.price`. */
  verify(proof: string, ctx: VerifyContext): Promise<VerifyResult>;
}

/**
 * Buyer-side counterpart of {@link PaymentRail}: pays an {@link Offer} of one
 * scheme and returns the proof to present on retry. Payers take their own
 * injected dependency (a wallet for L402), mirroring how rails inject theirs.
 */
export interface PaymentPayer {
  /** Scheme id this payer settles, matching {@link Offer.scheme}. */
  readonly scheme: string;
  /** Pay `offer` and return the proof string plus what was spent. */
  pay(offer: Offer): Promise<{ proof: string; amount: number; asset: string }>;
}

/** Creates the Lightning invoice that backs an L402 {@link Offer}. */
export interface InvoiceProvider {
  /**
   * Create an invoice for `amountSat`. Return the BOLT11 string and the payment
   * hash (hex) that the buyer's revealed preimage must hash to. Wrap your own
   * wallet (NWC / LND / phoenixd / LNbits) or a bolthub-hosted facilitator.
   */
  createInvoice(amountSat: number, memo: string): Promise<{ invoice: string; paymentHash: string }>;
}

// --- Minimal structural MCP shapes -----------------------------------------
// Declared here (not imported from @modelcontextprotocol/sdk) so `@bolthub/pay`
// has no runtime dependency on the MCP SDK. They are structural subsets of the
// SDK's `CallToolResult` / `RequestHandlerExtra`, so a wrapped handler drops
// straight into `server.tool(name, schema, handler)`.

/** Subset of MCP's `CallToolResult`. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Subset of MCP's `RequestHandlerExtra` — carries the request's `_meta`. */
export interface ToolExtra {
  _meta?: Record<string, unknown>;
}

/** An MCP tool handler. The wrapped handler returned by the paywall has this shape. */
export type ToolHandler = (
  args: Record<string, unknown>,
  extra?: ToolExtra,
) => Promise<ToolResult> | ToolResult;

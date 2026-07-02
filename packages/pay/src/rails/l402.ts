/**
 * The Lightning / L402 settlement rail for {@link createPaywall}.
 *
 * Mints a BOLT11 invoice + HMAC-signed token per offer and verifies
 * `<token>:<preimage>` proofs. Wire-compatible with the bolthub gateway's L402
 * scheme, so a tool paywalled with this rail and an endpoint behind the gateway
 * speak the same bytes.
 */

import { signL402Token, verifyL402Token, verifyPreimage } from "../token";
import type {
  InvoiceProvider,
  Offer,
  PaymentRail,
  Price,
  ResourceRef,
  VerifyContext,
  VerifyResult,
} from "../types";

export interface L402RailOptions {
  /**
   * HMAC secret used to sign and verify L402 tokens. MUST be ≥ 32 bytes and
   * kept private — anyone with it can mint tokens. Pass the same secret you
   * verify with; rotate by re-issuing under a new secret.
   */
  secret: string;
  /** Creates the Lightning invoice that backs each offer. */
  invoiceProvider: InvoiceProvider;
  /** Token lifetime in seconds. Default 900 (15 min) — matches the gateway. */
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 15 * 60;

/** Build the L402 {@link PaymentRail}. */
export function l402Rail(options: L402RailOptions): PaymentRail {
  if (!options.secret || options.secret.length < 32) {
    throw new Error("l402Rail: `secret` must be at least 32 bytes");
  }
  const ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;

  return {
    scheme: "l402",
    assets: ["sat"],

    async createOffer(price: Required<Price>, resource: ResourceRef): Promise<Offer> {
      if (price.asset !== "sat") {
        throw new Error(`l402Rail settles in "sat", not "${price.asset}"`);
      }
      const { invoice, paymentHash } = await options.invoiceProvider.createInvoice(
        price.amount,
        `bolthub: ${resource}`,
      );
      const expiresAt = Date.now() + ttlMs;
      const token = signL402Token(options.secret, { paymentHash, resource, expiresAt });
      return {
        scheme: "l402",
        amount: price.amount,
        asset: "sat",
        token,
        invoice,
        expiresAt,
        // The exact header a gateway/origin would emit over HTTP, included so an
        // HTTP-native buyer can reuse one parser across transports.
        wwwAuthenticate: `L402 macaroon="${token}", invoice="${invoice}"`,
      };
    },

    async verify(proof: string, ctx: VerifyContext): Promise<VerifyResult> {
      // Proof is `<token>:<preimage>`. The token (base64url + "." + hex sig) and
      // the preimage (hex) contain no ":", so split on the last colon.
      const sep = proof.lastIndexOf(":");
      if (sep <= 0 || sep === proof.length - 1) {
        return { ok: false, reason: "malformed l402 proof" };
      }
      const token = proof.slice(0, sep);
      const preimage = proof.slice(sep + 1);

      const verified = verifyL402Token(options.secret, token);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      if (verified.payload.resource !== ctx.resource) {
        return { ok: false, reason: "proof scoped to a different resource" };
      }
      if (!verifyPreimage(preimage, verified.payload.paymentHash)) {
        return { ok: false, reason: "preimage does not match the invoice" };
      }
      return { ok: true, resource: ctx.resource, amount: ctx.price.amount };
    },
  };
}

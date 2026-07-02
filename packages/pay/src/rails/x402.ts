/**
 * The x402 (stablecoin) settlement rail for {@link createPaywall}.
 *
 * Mirrors the [x402](https://www.x402.org/) model: the seller advertises
 * **payment requirements**, the buyer returns a base64 `X-PAYMENT` payload (an
 * EIP-3009/USDC `transferWithAuthorization` signature), and verification +
 * settlement are delegated to a **facilitator** (Coinbase-hosted or self-hosted).
 *
 * Verification is stateless: the seller reconstructs the requirements from its
 * own config + the called resource + the offered price — it never trusts the
 * client for the amount. The facilitator is injected ({@link FacilitatorClient}),
 * mirroring how {@link l402Rail} injects its `InvoiceProvider`. No on-chain
 * crypto dependency is pulled in; local EIP-712 verification is a future option.
 */

import type { Offer, PaymentRail, Price, ResourceRef, VerifyContext, VerifyResult } from "../types";

/** x402 payment requirements (one `accepts` entry), seller → buyer. */
export interface X402Requirements {
  /** x402 settlement scheme, e.g. `"exact"`. Distinct from the rail scheme `"x402"`. */
  scheme: string;
  /** Chain, e.g. `"base"` or `"base-sepolia"`. */
  network: string;
  /** Amount required, in the asset's atomic units, as a string. */
  maxAmountRequired: string;
  /** Resource identifier the payment is for. */
  resource: string;
  description?: string;
  mimeType?: string;
  /** Recipient address. */
  payTo: string;
  /** Window the buyer's authorization may remain valid, in seconds. */
  maxTimeoutSeconds: number;
  /** Token contract address. */
  asset: string;
  /** Extra fields (e.g. EIP-712 token domain `name`/`version`). */
  extra?: Record<string, unknown>;
}

/** x402 payment payload, base64-decoded from the buyer's `X-PAYMENT`. Opaque here; the facilitator verifies it. */
export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: unknown;
}

/** Delegate that verifies (and optionally settles) an x402 payment. */
export interface FacilitatorClient {
  /** Check a payment payload against the requirements (signature, balance, amount). */
  verify(
    payment: X402PaymentPayload,
    requirements: X402Requirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  /** Broadcast/settle the payment. Optional — omit to verify-only. */
  settle?(
    payment: X402PaymentPayload,
    requirements: X402Requirements,
  ): Promise<{ success: boolean; txHash?: string; errorReason?: string }>;
}

export interface X402RailOptions {
  /** Chain, e.g. `"base"` or `"base-sepolia"`. */
  network: string;
  /** Token contract address (e.g. USDC on the chosen network). */
  asset: string;
  /** Recipient address payments are sent to. */
  payTo: string;
  /** Verifies/settles payments. Wrap Coinbase's facilitator or self-host one. */
  facilitator: FacilitatorClient;
  /** Symbol used to match a {@link Price}'s asset to this rail. Default `"usdc"`. */
  assetSymbol?: string;
  /** Extra requirements fields (e.g. `{ name: "USD Coin", version: "2" }` for EIP-712). */
  extra?: Record<string, unknown>;
  /** x402 settlement scheme. Default `"exact"`. */
  scheme?: string;
  /** Authorization validity window in seconds. Default 60. */
  maxTimeoutSeconds?: number;
  /** x402 protocol version echoed in offers. Default 1. */
  x402Version?: number;
  /** Settle (not just verify) when a proof checks out. Default true. */
  settle?: boolean;
}

/** Build the x402 {@link PaymentRail}. */
export function x402Rail(options: X402RailOptions): PaymentRail {
  if (!options.network) throw new Error("x402Rail: `network` is required");
  if (!options.asset) throw new Error("x402Rail: `asset` (token contract address) is required");
  if (!options.payTo) throw new Error("x402Rail: `payTo` address is required");
  if (!options.facilitator) throw new Error("x402Rail: a `facilitator` is required");

  const assetSymbol = options.assetSymbol ?? "usdc";
  const scheme = options.scheme ?? "exact";
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 60;
  const x402Version = options.x402Version ?? 1;
  const settle = options.settle ?? true;

  /** Deterministically rebuild requirements from config + resource + amount. */
  function requirementsFor(amountAtomic: number, resource: ResourceRef): X402Requirements {
    const reqs: X402Requirements = {
      scheme,
      network: options.network,
      maxAmountRequired: String(amountAtomic),
      resource,
      payTo: options.payTo,
      maxTimeoutSeconds,
      asset: options.asset,
    };
    if (options.extra) reqs.extra = options.extra;
    return reqs;
  }

  return {
    scheme: "x402",
    assets: [assetSymbol],

    async createOffer(price: Required<Price>, resource: ResourceRef): Promise<Offer> {
      if (price.asset !== assetSymbol) {
        throw new Error(`x402Rail settles in "${assetSymbol}", not "${price.asset}"`);
      }
      return {
        scheme: "x402",
        amount: price.amount,
        asset: assetSymbol,
        network: options.network,
        payTo: options.payTo,
        x402Version,
        // The full x402 payment-requirements list an x402-native client expects.
        accepts: [requirementsFor(price.amount, resource)],
      };
    },

    async verify(proof: string, ctx: VerifyContext): Promise<VerifyResult> {
      // Proof is the base64 `X-PAYMENT` value: base64(JSON(X402PaymentPayload)).
      let payment: X402PaymentPayload;
      try {
        payment = JSON.parse(Buffer.from(proof, "base64").toString("utf8")) as X402PaymentPayload;
      } catch {
        return { ok: false, reason: "malformed x402 payment payload" };
      }
      if (!payment || payment.scheme !== scheme || payment.network !== options.network) {
        return { ok: false, reason: "payment scheme/network does not match the offer" };
      }

      // Requirements are reconstructed from OUR config + the offered price — the
      // client is never trusted for the amount.
      const requirements = requirementsFor(ctx.price.amount, ctx.resource);

      const verified = await options.facilitator.verify(payment, requirements);
      if (!verified.isValid) {
        return { ok: false, reason: verified.invalidReason ?? "facilitator rejected the payment" };
      }
      if (settle && options.facilitator.settle) {
        const settled = await options.facilitator.settle(payment, requirements);
        if (!settled.success) {
          return { ok: false, reason: settled.errorReason ?? "settlement failed" };
        }
      }
      return { ok: true, resource: ctx.resource, amount: ctx.price.amount };
    },
  };
}

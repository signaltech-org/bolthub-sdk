/**
 * Buyer-side x402 payer: sign the offer's payment requirements into an
 * `X-PAYMENT` payload and return it (base64) as the proof.
 *
 * The actual EIP-3009/USDC signing is delegated to an injected {@link X402Signer}
 * (wrap viem/ethers, or an x402 client library), so this package pulls in no
 * on-chain crypto dependency.
 */

import type { X402PaymentPayload, X402Requirements } from "../rails/x402";
import type { Offer, PaymentPayer } from "../types";

/** Produces a signed x402 payment payload authorizing a set of requirements. */
export interface X402Signer {
  authorize(requirements: X402Requirements): Promise<X402PaymentPayload>;
}

export interface X402PayerOptions {
  signer: X402Signer;
}

/** Build the x402 {@link PaymentPayer}. */
export function x402Payer(options: X402PayerOptions): PaymentPayer {
  return {
    scheme: "x402",
    async pay(offer: Offer) {
      const accepts = Array.isArray(offer.accepts) ? (offer.accepts as X402Requirements[]) : [];
      const requirements = accepts[0];
      if (!requirements) {
        throw new Error("x402 offer is missing `accepts[0]` requirements");
      }
      const payload = await options.signer.authorize(requirements);
      const proof = Buffer.from(JSON.stringify(payload)).toString("base64");
      return { proof, amount: Number(offer.amount), asset: String(offer.asset) };
    },
  };
}

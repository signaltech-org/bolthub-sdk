/**
 * The Nano (XNO) settlement rail for {@link createPaywall}.
 *
 * A second {@link PaymentRail} beside the L402 rail. Nano needs no invoice,
 * no preimage, no routing and no liquidity: a buyer pays by signing a single
 * send block to the seller's Nano account, and the transfer is final in well
 * under a second at zero fee. The rail is deliberately dependency-free — the
 * verification seam is injected, matching the repo's rule that the payment
 * path carries no third-party runtime dependencies.
 */

import type { Offer, PaymentRail, Price, ResourceRef, VerifyContext, VerifyResult } from "../types";

/** A Nano "invoice": the seller's receive account plus the price in raw. */
export interface NanoOfferFields {
  /** Seller's Nano (XNO) account that receives payment. */
  account: string;
}

export interface NanoRailOptions {
  /**
   * Seller's Nano (XNO) account that receives payment. This is the public
   * receive address published on the offer; the buyer sends XNO to it.
   */
  receiveAccount: string;
  /**
   * Verifier: confirms that `proof` (a signed Nano send-block hash/reference)
   * paid `account` the `amountRaw` and is scoped to `resource`. Injectable so
   * tests and offline flows never touch the network; the production binding
   * checks a Nano RPC (e.g. rpc.nano.to) for a confirmed block.
   */
  verify: (
    account: string,
    amountRaw: string,
    resource: string,
  ) => Promise<boolean>;
}

/** 10^30 raw per XNO (Nano's smallest unit). */
export const XNO_RAW = 10n ** 30n;

/** Build the Nano {@link PaymentRail}. */
export function nanoRail(options: NanoRailOptions): PaymentRail {
  if (!options.receiveAccount || !options.receiveAccount.startsWith("nano_")) {
    throw new Error("nanoRail: `receiveAccount` must be a valid nano_ address");
  }
  return {
    scheme: "nano",
    assets: ["XNO"],

    async createOffer(price: Required<Price>, resource: ResourceRef): Promise<Offer> {
      if (price.asset !== "XNO") {
        throw new Error(`nanoRail settles in "XNO", not "${price.asset}"`);
      }
      // Nano has no invoice expiry, preimage or liquidity to reference. The
      // offer is just the seller's account + the price (XNO, base unit = raw).
      return {
        scheme: "nano",
        amount: price.amount,
        asset: "XNO",
        account: options.receiveAccount,
        resource,
        // No expiry: a Nano send settles the moment it is confirmed.
        expiresAt: 0,
        // HTTP header shape for an HTTP-native buyer, mirroring how the L402
        // rail emits `wwwAuthenticate` so one parser can cover both.
        wwwAuthenticate: `Nano account="${options.receiveAccount}", asset="XNO", amount="${price.amount}"`,
      };
    },

    async verify(proof: string, ctx: VerifyContext): Promise<VerifyResult> {
      if (!proof) {
        return { ok: false, reason: "missing nano proof" };
      }
      const amountRaw = (BigInt(ctx.price.amount) * XNO_RAW).toString();
      const ok = await options.verify(options.receiveAccount, amountRaw, ctx.resource);
      if (!ok) return { ok: false, reason: "nano proof did not verify" };
      return { ok: true, resource: ctx.resource, amount: ctx.price.amount };
    },
  };
}

/**
 * Buyer-side L402 payer: pay the offer's Lightning invoice and return the
 * `<token>:<preimage>` proof.
 */

import type { Offer, PaymentPayer } from "../types";
import type { WalletAdapter } from "../http/types";

/**
 * Anything that can pay a BOLT11 invoice and return its preimage — the same
 * {@link WalletAdapter} the HTTP `L402Client` uses, so `NwcWallet`,
 * `LndWallet`, `PhoenixdWallet`, etc. drop straight in. (Alias kept from
 * 0.3.x, when the wallets lived in `@bolthub/agent`.)
 */
export type L402PayerWallet = WalletAdapter;

export interface L402PayerOptions {
  wallet: L402PayerWallet;
}

/** Build the L402 {@link PaymentPayer}. */
export function l402Payer(options: L402PayerOptions): PaymentPayer {
  return {
    scheme: "l402",
    async pay(offer: Offer) {
      const invoice = typeof offer.invoice === "string" ? offer.invoice : "";
      const token = typeof offer.token === "string" ? offer.token : "";
      if (!invoice || !token) {
        throw new Error("l402 offer is missing `invoice` or `token`");
      }
      const { preimage } = await options.wallet.payInvoice(invoice);
      if (!preimage) throw new Error("wallet returned an empty preimage");
      return { proof: `${token}:${preimage}`, amount: Number(offer.amount), asset: String(offer.asset) };
    },
  };
}

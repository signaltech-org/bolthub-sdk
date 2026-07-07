import type { WalletAdapter } from "../http/types";

/** Configuration for connecting to an LNbits instance. */
export interface LnbitsWalletOptions {
  /** LNbits base URL, e.g. `https://lnbits.example.com`. */
  url: string;
  /** Admin API key for the wallet with outgoing payment permission. */
  adminKey: string;
}

/**
 * Wallet adapter that pays invoices through an LNbits instance
 * (`POST /api/v1/payments`).
 */
export class LnbitsWallet implements WalletAdapter {
  private url: string;
  private adminKey: string;

  constructor(options: LnbitsWalletOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.adminKey = options.adminKey;
  }

  async payInvoice(bolt11: string): Promise<{ preimage: string }> {
    const resp = await fetch(`${this.url}/api/v1/payments`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.adminKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ out: true, bolt11 }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`LNbits payment failed (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    const preimage = data.preimage ?? data.payment_preimage;
    if (!preimage) {
      throw new Error("LNbits payment response missing preimage");
    }

    return { preimage };
  }
}

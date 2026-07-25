import type { WalletAdapter, WalletDiagnostics } from "../http/types";

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

  async diagnose(): Promise<WalletDiagnostics> {
    const d: WalletDiagnostics = { kind: "lnbits" };
    try {
      const resp = await fetch(`${this.url}/api/v1/wallet`, {
        headers: { "X-Api-Key": this.adminKey },
      });
      if (!resp.ok) {
        d.limitations = [`wallet probe refused (HTTP ${resp.status}) — check the API key`];
        return d;
      }
      const body = await resp.json();
      // LNbits reports balance in millisats.
      if (Number.isFinite(Number(body.balance))) d.balanceSats = Math.floor(Number(body.balance) / 1000);
      if (body.name) d.alias = body.name;
    } catch (err) {
      d.limitations = [`wallet probe failed: ${err instanceof Error ? err.message : String(err)}`];
    }
    return d;
  }
}

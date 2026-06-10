import type { WalletAdapter } from "../types";

/** Configuration for connecting to an LND node via its REST API. */
export interface LndWalletOptions {
  /** LND REST endpoint, e.g. `https://localhost:8080`. */
  host: string;
  /** Hex-encoded admin macaroon with permission to send payments. */
  macaroon: string;
  /** Payment timeout in seconds passed to LND. Defaults to 30. */
  timeoutSeconds?: number;
}

/**
 * Wallet adapter that pays invoices through an LND node's REST API
 * (`POST /v2/router/send`).
 */
export class LndWallet implements WalletAdapter {
  private host: string;
  private macaroon: string;
  private timeoutSeconds: number;

  constructor(options: LndWalletOptions) {
    this.host = options.host.replace(/\/$/, "");
    this.macaroon = options.macaroon;
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
  }

  async payInvoice(bolt11: string): Promise<{ preimage: string }> {
    const resp = await fetch(`${this.host}/v2/router/send`, {
      method: "POST",
      headers: {
        "Grpc-Metadata-macaroon": this.macaroon,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payment_request: bolt11,
        timeout_seconds: this.timeoutSeconds,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`LND payment failed (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    const preimage = data.result?.payment_preimage;
    if (!preimage) {
      throw new Error("LND payment response missing preimage");
    }

    return { preimage };
  }
}

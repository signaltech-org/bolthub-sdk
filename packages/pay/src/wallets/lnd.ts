import type { WalletAdapter, WalletDiagnostics } from "../http/types";

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

  async diagnose(): Promise<WalletDiagnostics> {
    const d: WalletDiagnostics = { kind: "lnd" };
    const limitations: string[] = [];

    try {
      const resp = await fetch(`${this.host}/v1/balance/channels`, {
        headers: { "Grpc-Metadata-macaroon": this.macaroon },
      });
      if (!resp.ok) {
        limitations.push(`channel-balance probe refused (HTTP ${resp.status}) — the macaroon may lack read permission`);
      } else {
        const body = await resp.json();
        const sats = Number(body.local_balance?.sat ?? body.balance);
        if (Number.isFinite(sats)) d.balanceSats = sats;
      }
    } catch (err) {
      limitations.push(`channel-balance probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const resp = await fetch(`${this.host}/v1/getinfo`, {
        headers: { "Grpc-Metadata-macaroon": this.macaroon },
      });
      if (resp.ok) {
        const info = await resp.json();
        if (info.alias) d.alias = info.alias;
        if (info.identity_pubkey) d.pubkey = info.identity_pubkey;
        const chain = Array.isArray(info.chains) ? info.chains[0] : undefined;
        if (chain?.network) d.network = chain.network;
      } else {
        limitations.push(`getinfo probe refused (HTTP ${resp.status})`);
      }
    } catch (err) {
      limitations.push(`getinfo probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (limitations.length > 0) d.limitations = limitations;
    return d;
  }
}

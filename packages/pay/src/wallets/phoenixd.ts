import type { WalletAdapter, WalletDiagnostics } from "../http/types";

/** Configuration for connecting to a Phoenixd node. */
export interface PhoenixdWalletOptions {
  /** Phoenixd HTTP base URL, e.g. `http://localhost:9740`. */
  baseUrl: string;
  /** HTTP password used for Basic authentication. */
  password: string;
  /** Payment request timeout in milliseconds. Defaults to 35 000. */
  timeoutMs?: number;
}

/**
 * Wallet adapter that pays invoices through a Phoenixd node
 * (`POST /payinvoice`).
 */
export class PhoenixdWallet implements WalletAdapter {
  private baseUrl: string;
  private authHeader: string;
  private timeoutMs: number;

  constructor(options: PhoenixdWalletOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${btoa(`:${options.password}`)}`;
    this.timeoutMs = options.timeoutMs ?? 35_000;
  }

  async payInvoice(bolt11: string): Promise<{ preimage: string }> {
    const resp = await fetch(`${this.baseUrl}/payinvoice`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ invoice: bolt11 }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Phoenixd payment failed (${resp.status}): ${body}`);
    }

    const data = await resp.json();
    const preimage = data.paymentPreimage ?? data.preimage;
    if (!preimage) {
      throw new Error("Phoenixd payment response missing preimage");
    }

    return { preimage };
  }

  async diagnose(): Promise<WalletDiagnostics> {
    const d: WalletDiagnostics = { kind: "phoenixd" };
    try {
      const resp = await fetch(`${this.baseUrl}/getbalance`, {
        headers: { Authorization: this.authHeader },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!resp.ok) {
        d.limitations = [`balance probe refused (HTTP ${resp.status}) — check the password`];
        return d;
      }
      const body = await resp.json();
      if (Number.isFinite(Number(body.balanceSat))) d.balanceSats = Number(body.balanceSat);
    } catch (err) {
      d.limitations = [`balance probe failed: ${err instanceof Error ? err.message : String(err)}`];
    }
    return d;
  }
}

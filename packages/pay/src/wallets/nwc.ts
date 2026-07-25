import type { WalletAdapter, WalletDiagnostics } from "../http/types";

/**
 * Minimal interface a Nostr Wallet Connect connection must satisfy.
 * Compatible with `@getalby/sdk`'s `NWCClient`. Only `payInvoice` is
 * required; the optional probes power {@link NwcWallet.diagnose} — a
 * connection without them still pays fine, it just can't be inspected.
 */
export interface NwcConnection {
  payInvoice(invoice: string): Promise<{ preimage: string }>;
  /** NIP-47 `get_balance`, normalized to sats. */
  getBalance?(): Promise<{ balanceSats: number }>;
  /** NIP-47 `get_info`: identity plus the methods this connection may call. */
  getInfo?(): Promise<{ alias?: string; network?: string; pubkey?: string; methods?: string[] }>;
  /** The wallet-service pubkey this connection points at (from the NWC URI). */
  walletPubkey?: string;
}

/**
 * Wallet adapter that delegates payment to a Nostr Wallet Connect (NWC)
 * connection. Pass any object implementing {@link NwcConnection}.
 */
export class NwcWallet implements WalletAdapter {
  private connection: NwcConnection;

  /** Optional teardown; set by owners that hold the relay socket (see {@link WalletAdapter.close}). */
  close?: () => void;

  constructor(connection: NwcConnection) {
    this.connection = connection;
  }

  async payInvoice(bolt11: string): Promise<{ preimage: string }> {
    return this.connection.payInvoice(bolt11);
  }

  async diagnose(): Promise<WalletDiagnostics> {
    const d: WalletDiagnostics = { kind: "nwc" };
    const limitations: string[] = [];
    if (this.connection.walletPubkey) d.pubkey = this.connection.walletPubkey;

    if (this.connection.getInfo) {
      try {
        const info = await this.connection.getInfo();
        if (info.alias) d.alias = info.alias;
        if (info.network) d.network = info.network;
        if (info.pubkey) d.pubkey = d.pubkey ?? info.pubkey;
        if (info.methods) {
          d.methods = info.methods;
          d.canPayInvoices = info.methods.includes("pay_invoice");
        }
      } catch (err) {
        limitations.push(`get_info failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      limitations.push("this connection object exposes payInvoice only (no get_info probe)");
    }

    if (this.connection.getBalance) {
      try {
        d.balanceSats = (await this.connection.getBalance()).balanceSats;
      } catch (err) {
        limitations.push(`get_balance failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (limitations.length > 0) d.limitations = limitations;
    return d;
  }
}

import type { WalletAdapter } from "../http/types";

/**
 * Minimal interface a Nostr Wallet Connect connection must satisfy.
 * Compatible with `@getalby/sdk`'s `NWCClient`.
 */
export interface NwcConnection {
  payInvoice(invoice: string): Promise<{ preimage: string }>;
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
}

/**
 * Wallet bootstrap: `walletFromEnv()` from `@bolthub/pay` plus the NWC
 * connector this package can provide (`@getalby/sdk` is a real dependency
 * here — pay itself stays zero-dep).
 *
 * Unlike the old bins, NO wallet is not an error: the server still serves
 * free tools and marketplace search, and paid calls return the challenge
 * with a setup hint.
 */

import { walletFromEnv } from "@bolthub/pay";
import type { NwcConnection, WalletAdapter } from "@bolthub/pay";
import { log } from "./log";

async function nwcConnect(uri: string): Promise<NwcConnection & { close?: () => void }> {
  const { NWCClient } = await import("@getalby/sdk");
  const client = new NWCClient({ nostrWalletConnectUrl: uri });
  return {
    payInvoice: async (invoice: string) => {
      const result = await client.payInvoice({ invoice });
      return { preimage: result.preimage };
    },
    close: () => client.close(),
  };
}

export async function createWallet(): Promise<WalletAdapter | undefined> {
  return walletFromEnv({ nwcConnect, log });
}

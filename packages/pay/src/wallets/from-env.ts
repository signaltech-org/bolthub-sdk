/**
 * Build a wallet adapter from the standard bolthub environment variables —
 * the one place the env-var → wallet mapping lives (previously copy-pasted
 * across the cli / mcp-bridge / mcp-registry bins).
 *
 * Checked in priority order:
 *
 *   LND_REST_HOST + LND_MACAROON        LND REST (fastest, <200ms)
 *   LNBITS_URL + LNBITS_ADMIN_KEY       LNbits (fast, <300ms)
 *   PHOENIXD_URL + PHOENIXD_PASSWORD    phoenixd (fast, <200ms)
 *   NWC_URI                             Nostr Wallet Connect (slower, 1-3s via relay)
 *
 * Returns `undefined` when none are set, so callers can run in a
 * free-tools-only mode instead of exiting.
 *
 * NWC needs a protocol implementation this zero-dependency package does not
 * ship: pass `nwcConnect` (e.g. backed by `@getalby/sdk`'s `NWCClient`).
 * `NWC_URI` set without a connector is a configuration error and throws.
 */

import { LndWallet } from "./lnd";
import { LnbitsWallet } from "./lnbits";
import { PhoenixdWallet } from "./phoenixd";
import { NwcWallet, type NwcConnection } from "./nwc";
import type { WalletAdapter } from "../http/types";

export interface WalletFromEnvOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * NWC connector factory: given the `NWC_URI` value, return a connection
   * that can pay invoices (and optionally `close()` its relay socket).
   */
  nwcConnect?: (uri: string) => Promise<NwcConnection & { close?: () => void }>;
  /** Progress logger (bins pass a stderr logger); silent by default. */
  log?: (message: string) => void;
}

/** Human-readable setup hint, for bins to print when no wallet is configured. */
export const WALLET_ENV_HINT = [
  "Set one of the following to configure a wallet:",
  "  PHOENIXD_URL + PHOENIXD_PASSWORD     (recommended, fast <200ms)",
  "  LND_REST_HOST + LND_MACAROON         (fastest, <200ms)",
  "  LNBITS_URL + LNBITS_ADMIN_KEY        (fast, <300ms)",
  "  NWC_URI                              (easiest, but slower 1-3s)",
].join("\n");

export async function walletFromEnv(
  options: WalletFromEnvOptions = {},
): Promise<WalletAdapter | undefined> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});

  if (env.LND_REST_HOST && env.LND_MACAROON) {
    log("Using LND wallet (fastest, <200ms payments)");
    return new LndWallet({ host: env.LND_REST_HOST, macaroon: env.LND_MACAROON });
  }

  if (env.LNBITS_URL && env.LNBITS_ADMIN_KEY) {
    log("Using LNbits wallet (fast, <300ms payments)");
    return new LnbitsWallet({ url: env.LNBITS_URL, adminKey: env.LNBITS_ADMIN_KEY });
  }

  if (env.PHOENIXD_URL && env.PHOENIXD_PASSWORD) {
    log("Using Phoenixd wallet (fast, <200ms payments)");
    return new PhoenixdWallet({ baseUrl: env.PHOENIXD_URL, password: env.PHOENIXD_PASSWORD });
  }

  if (env.NWC_URI) {
    if (!options.nwcConnect) {
      throw new Error(
        "NWC_URI is set but no `nwcConnect` factory was provided — " +
          "@bolthub/pay ships no NWC protocol implementation (zero dependencies). " +
          "Pass one, e.g. backed by @getalby/sdk's NWCClient.",
      );
    }
    log("Using NWC wallet (slower, 1-3s payments via relay)");
    const connection = await options.nwcConnect(env.NWC_URI);
    const wallet = new NwcWallet(connection);
    if (connection.close) wallet.close = () => connection.close?.();
    return wallet;
  }

  return undefined;
}

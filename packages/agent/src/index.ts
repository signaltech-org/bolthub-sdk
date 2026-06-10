export { L402Client, L402Error, L402BudgetError, L402TimeoutError, L402PaymentError } from "./client";
export { LndWallet } from "./wallets/lnd";
export { LnbitsWallet } from "./wallets/lnbits";
export { NwcWallet } from "./wallets/nwc";
export { WebLnWallet, isWebLnAvailable } from "./wallets/webln";
export { PhoenixdWallet } from "./wallets/phoenixd";
export { FileSessionStore } from "./session-store";
export type { SessionStore, SessionData } from "./session-store";
export type { WalletAdapter, L402ClientOptions, L402Challenge, L402RequestOptions } from "./types";
export type { LndWalletOptions } from "./wallets/lnd";
export type { LnbitsWalletOptions } from "./wallets/lnbits";
export type { NwcConnection } from "./wallets/nwc";
export type { PhoenixdWalletOptions } from "./wallets/phoenixd";

import { L402Client as _L402Client } from "./client";
import type { L402ClientOptions } from "./types";

/** Shorthand factory that creates and returns a new {@link L402Client} instance. */
export function createL402Client(options: L402ClientOptions): _L402Client {
  return new _L402Client(options);
}

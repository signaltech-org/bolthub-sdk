export { L402Client, L402Error, L402BudgetError, L402TimeoutError, L402PaymentError } from "./http/client";
export { LnbitsWallet } from "./wallets/lnbits";
export { NwcWallet } from "./wallets/nwc";
export { WebLnWallet, isWebLnAvailable } from "./wallets/webln";
// FileSessionStore is intentionally omitted — it uses Node.js fs/path/os APIs
export type { SessionStore, SessionData } from "./http/session-store";
export type { WalletAdapter, L402ClientOptions, L402Challenge, L402RequestOptions } from "./http/types";
export type { LnbitsWalletOptions } from "./wallets/lnbits";
export type { NwcConnection } from "./wallets/nwc";

import { L402Client as _L402Client } from "./http/client";
import type { L402ClientOptions } from "./http/types";

export function createL402Client(options: L402ClientOptions): _L402Client {
  return new _L402Client(options);
}

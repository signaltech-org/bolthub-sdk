/**
 * Adapter that any Lightning wallet must implement to be used with {@link L402Client}.
 *
 * Supply a built-in adapter (`LndWallet`, `LnbitsWallet`, etc.) or provide
 * your own object that satisfies this interface.
 */
export interface WalletAdapter {
  /** Pay a BOLT-11 Lightning invoice and return the payment preimage. */
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
}

/** Options accepted by the {@link L402Client} constructor. */
export interface L402ClientOptions {
  /** Lightning wallet adapter used to pay invoices. */
  wallet: WalletAdapter;

  /** Maximum sats allowed for a single invoice. Requests exceeding this throw {@link L402BudgetError}. */
  maxPerRequestSats?: number;

  /** Total sats the client may spend over its lifetime before refusing to pay. */
  budgetSats?: number;

  /** Timeout in milliseconds for each HTTP round-trip. Defaults to 45 000. */
  timeoutMs?: number;

  /**
   * Automatic retries when the wallet fails to pay, with exponential
   * backoff. Targets transient transport failures — NWC relays in
   * particular refuse connections intermittently. Retries re-attempt the
   * SAME invoice, which the Lightning network settles at most once, so a
   * retry can never double-pay. Defaults to 2; set 0 to disable.
   */
  payRetries?: number;

  /** Optional callback invoked when the request transitions between L402 stages. */
  onStage?: (stage: "invoice" | "paying" | "loading") => void;

  /**
   * Pluggable session store for persisting session tokens between requests.
   * Defaults to an in-memory store. Use {@link FileSessionStore} for disk persistence.
   */
  sessionStore?: import("./session-store").SessionStore;
}

/** Parsed L402 challenge extracted from a `WWW-Authenticate` header. */
export interface L402Challenge {
  macaroon: string;
  invoice: string;
}

/** Extended `RequestInit` that adds query-parameter helpers to every request. */
export interface L402RequestOptions extends RequestInit {
  /** Key-value pairs appended to the URL as query parameters. */
  params?: Record<string, string>;
}

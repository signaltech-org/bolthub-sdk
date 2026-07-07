/**
 * Adapter that any Lightning wallet must implement to be used with {@link L402Client}.
 *
 * Supply a built-in adapter (`LndWallet`, `LnbitsWallet`, etc.) or provide
 * your own object that satisfies this interface.
 */
export interface WalletAdapter {
  /** Pay a BOLT-11 Lightning invoice and return the payment preimage. */
  payInvoice(bolt11: string): Promise<{ preimage: string }>;

  /**
   * Optional teardown for adapters that hold a connection open (NWC keeps a
   * relay websocket alive). Owners should call it when done; clients never do.
   */
  close?(): void;
}

/** Options accepted by the {@link L402Client} constructor. */
export interface L402ClientOptions {
  /** Lightning wallet adapter used to pay invoices. */
  wallet: WalletAdapter;

  /** Maximum sats allowed for a single invoice. Requests exceeding this throw {@link L402BudgetError}. */
  maxPerRequestSats?: number;

  /** Total sats the client may spend over its lifetime before refusing to pay. */
  budgetSats?: number;

  /**
   * An external {@link import("../budget").Budget} to draw from instead of
   * `budgetSats`. Share one instance with a `ToolClient` to enforce a single
   * spending pool across the HTTP-402 and MCP payment paths. The budget's
   * `maxPerCall.sat` also caps each request when `maxPerRequestSats` is unset.
   * Mutually exclusive with `budgetSats`.
   */
  budget?: import("../budget").Budget;

  /** Called after a successful invoice payment, before the retried request. */
  onPaid?: (info: { scheme: "l402"; amount: number; asset: "sat"; resource: string }) => void;

  /**
   * Policy when an invoice's price cannot be determined from the body
   * (`amountSats`), the BOLT11 invoice, or `priceHeader`. `"cap"` (default)
   * pays only up to `maxPerRequestSats` (counted against the budget) and
   * refuses if no ceiling is set; `"refuse"` always throws
   * {@link L402BudgetError}; `"allow"` pays blind and counts nothing (legacy,
   * unsafe). The default never pays a price-less challenge blind.
   */
  onUnknownAmount?: "cap" | "refuse" | "allow";

  /** Optional response header to read the price (in sats) from when the body and invoice do not carry it. */
  priceHeader?: string;

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

  /**
   * One-off per-request spend ceiling in sats. Tightens (never loosens)
   * `maxPerRequestSats` and the budget's `maxPerCall.sat` for this call only.
   */
  maxCostSats?: number;

  /**
   * Per-request payment callback, fired in addition to the client-level
   * `onPaid`. Lets callers attribute an exact cost to this call — reading
   * `totalSpent` deltas instead is racy when a shared {@link import("../budget").Budget}
   * has other concurrent spenders.
   */
  onPaid?: (info: { scheme: "l402"; amount: number; asset: "sat"; resource: string }) => void;
}

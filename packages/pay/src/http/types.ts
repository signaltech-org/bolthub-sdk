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

  /**
   * Called after a successful invoice payment, before the retried request.
   * `preimage` (hex proof of payment) and `invoice` (the paid BOLT11) are
   * always populated on payment; `paymentHash` when the 402 body carried
   * it (bolthub gateways do) — otherwise derive it as sha256(preimage).
   * Together they form a verifiable receipt for the payment.
   */
  onPaid?: (info: PaidInfo) => void;

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

  /**
   * Automatic retries when the server answers `429 Too Many Requests`,
   * on every leg of the flow (challenge, session reuse, and the retry
   * after payment). Waits out the response's `Retry-After` (delta-seconds
   * or HTTP-date; 1s, 2s, … backoff when absent) and re-sends the SAME
   * request. On the post-payment leg this re-presents the same
   * `macaroon:preimage` — bolthub gateways revert the invoice consumption
   * when they answer 429, so the retry re-uses the payment rather than
   * paying twice. Requests with a stream body are not retried (the body
   * can't be re-read). Defaults to 2; set 0 to disable.
   */
  rateLimitRetries?: number;

  /**
   * Longest single `Retry-After` wait the client will honor, in
   * milliseconds; a 429 demanding more is returned to the caller
   * immediately. Defaults to 10 000.
   */
  maxRetryAfterMs?: number;

  /**
   * Automatic free retries when the gateway reports an upstream failure it
   * already un-charged (`X-Bolthub-Payment-Code: upstream_failed_retryable`
   * — the preimage redeems again / the deduction went back to the session
   * balance). Strictly signal-gated: a bare 5xx without the header is
   * returned untouched, because without the gateway's word the SDK cannot
   * know the payment survived. Defaults to true; set false to opt out.
   */
  retryOnUpstreamFailure?: boolean;

  /**
   * How many free retries to attempt on `upstream_failed_retryable`
   * responses, with jittered exponential backoff (250ms, 500ms, …).
   * Defaults to 2; set 0 to disable (equivalent to
   * `retryOnUpstreamFailure: false`).
   */
  upstreamRetries?: number;

  /**
   * When true, an `upstream_failed_retryable` response that survives all
   * retries throws {@link UpstreamFailedError} (which carries the parsed
   * payment status) instead of returning the failed `Response`. Defaults to
   * false to preserve the return-the-response contract.
   */
  throwOnUpstreamFailure?: boolean;

  /** Optional callback invoked when the request transitions between L402 stages. */
  onStage?: (stage: "invoice" | "paying" | "loading") => void;

  /**
   * Pluggable session store for persisting session tokens between requests.
   * Defaults to an in-memory store. Use {@link FileSessionStore} for disk persistence.
   */
  sessionStore?: import("./session-store").SessionStore;

  /**
   * Opt-in sink for preimage receipts: one record per settled payment
   * (schema v1: ts, resource, method, amount, payment hash, preimage,
   * invoice, outcome). Nothing is recorded when unset. Use
   * {@link FileReceiptStore} for a persistent `~/.bolthub/receipts.jsonl`
   * ledger. Receipt files carry live preimages; treat them like
   * credentials.
   */
  receiptStore?: import("./receipt-store").ReceiptStore;
}

/** Parsed L402 challenge extracted from a `WWW-Authenticate` header. */
export interface L402Challenge {
  macaroon: string;
  invoice: string;
}

/**
 * Payload passed to `onPaid` callbacks. The receipt fields (`preimage`,
 * `invoice`, `paymentHash`) are additive as of 0.4.x: older callbacks that
 * only read `amount`/`resource` keep working unchanged.
 */
export interface PaidInfo {
  scheme: "l402";
  amount: number;
  asset: "sat";
  resource: string;
  /** Hex proof of payment returned by the wallet. */
  preimage?: string;
  /** The BOLT11 invoice that was paid. */
  invoice?: string;
  /** From the 402 body when present; equals sha256(preimage). */
  paymentHash?: string;
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
   * has other concurrent spenders. Receives the same receipt fields as the
   * client-level callback ({@link PaidInfo}).
   */
  onPaid?: (info: PaidInfo) => void;
}

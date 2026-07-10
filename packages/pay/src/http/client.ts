import type { L402ClientOptions, L402Challenge, L402RequestOptions, WalletAdapter } from "./types";
import type { SessionStore, SessionData } from "./session-store";
import type { ReceiptStore } from "./receipt-store";
import { exportReceipts } from "./receipt-export";
import type { Budget } from "../budget";
import { bolt11AmountSats } from "./invoice";
import { readPaymentStatus, type PaymentStatus } from "./payment-status";

/** Lifecycle stage reported via {@link L402ClientOptions.onStage}. */
export type L402Stage = "invoice" | "paying" | "loading";

// Prepaid credit is tenant-scoped, so its credential is cached per HOST (every
// one of a provider's endpoints shares it), not per host+path. The gateway's
// 402 (credit spent/expired) is the authoritative invalidation; this 30-day
// floor just stops a definitely-dead credential being re-sent forever.
const CREDIT_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Snapshot of a cached session token returned by {@link L402Client.getSessions}. */
interface SessionInfo {
  token: string;
  expiresAt: number;
  balance?: number;
}

class InMemorySessionStore implements SessionStore {
  private map = new Map<string, SessionData>();
  get(key: string): SessionData | undefined { return this.map.get(key); }
  set(key: string, session: SessionData): void { this.map.set(key, session); }
  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  entries(): IterableIterator<[string, SessionData]> { return this.map.entries(); }
}

/**
 * HTTP client that transparently handles the L402 payment protocol.
 *
 * When a server responds with `402 Payment Required` and a
 * `WWW-Authenticate: L402` challenge, the client automatically pays the
 * embedded Lightning invoice via the configured wallet adapter, then
 * retries the request with the `Authorization: L402 <macaroon>:<preimage>`
 * header.
 *
 * Session tokens returned by gateways are cached so subsequent requests
 * to the same host+path skip the payment step until the session expires.
 *
 * Budget is reserved before the payment await, so concurrent requests on a
 * single client (e.g. via `Promise.all`) can never both pass the budget check
 * and overspend — `totalSpent` stays exact and the budget is never exceeded.
 *
 * @example
 * ```ts
 * const client = new L402Client({
 *   wallet: new LndWallet({ host, macaroon }),
 *   budgetSats: 10_000,
 * });
 * const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
 * ```
 */
export class L402Client {
  private wallet: WalletAdapter;
  private maxPerRequestSats: number;
  private budgetSats: number;
  private budget?: Budget;
  private onUnknownAmount: "cap" | "refuse" | "allow";
  private priceHeader?: string;
  private timeoutMs: number;
  private payRetries: number;
  private rateLimitRetries: number;
  private maxRetryAfterMs: number;
  private retryOnUpstreamFailure: boolean;
  private upstreamRetries: number;
  private throwOnUpstreamFailure: boolean;
  private spentSats = 0;
  private onStage?: (stage: L402Stage) => void;
  private onPaid?: L402ClientOptions["onPaid"];
  private store: SessionStore;
  private receiptStore?: ReceiptStore;
  // Prepaid-credit credentials by HOST (the settlement group): after buyCredit
  // pays once, its (macaroon:preimage) is presented on every request to any of
  // that provider's endpoints, drawing the prepaid budget with no new payment.
  private creditStore = new Map<string, { macaroon: string; preimage: string; expiresAt: number }>();

  constructor(options: L402ClientOptions) {
    if (options.budget && options.budgetSats !== undefined) {
      throw new L402Error("L402Client: pass either an external `budget` or `budgetSats`, not both");
    }
    this.wallet = options.wallet;
    this.maxPerRequestSats = options.maxPerRequestSats ?? Infinity;
    this.budgetSats = options.budgetSats ?? Infinity;
    this.budget = options.budget;
    this.onUnknownAmount = options.onUnknownAmount ?? "cap";
    this.priceHeader = options.priceHeader;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.payRetries = options.payRetries ?? 2;
    this.rateLimitRetries = options.rateLimitRetries ?? 2;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 10_000;
    this.retryOnUpstreamFailure = options.retryOnUpstreamFailure ?? true;
    this.upstreamRetries = options.upstreamRetries ?? 2;
    this.throwOnUpstreamFailure = options.throwOnUpstreamFailure ?? false;
    this.onStage = options.onStage;
    this.onPaid = options.onPaid;
    this.store = options.sessionStore ?? new InMemorySessionStore();
    this.receiptStore = options.receiptStore;
  }

  /**
   * Total satoshis spent since construction. When an external {@link Budget}
   * is shared with other clients, this reads the SHARED pool.
   */
  get totalSpent(): number {
    return this.budget ? this.budget.spentFor("sat") : this.spentSats;
  }

  /** Satoshis remaining before the client refuses to pay further invoices. */
  get remainingBudget(): number {
    return this.budget
      ? this.budget.remainingFor("sat")
      : Math.max(0, this.budgetSats - this.spentSats);
  }

  /**
   * Reserve `sats` from this client's budget for a delegated child credential
   * (AF-D6). The child is spent by a different process, so the only way the
   * parent can keep parent + children from jointly exceeding its budget is to
   * hold the child's cap now (SPIKE-6 reserve semantics). Throws
   * {@link L402BudgetError} when the cap exceeds the remaining budget (boundary:
   * `== remaining` accepted, `remaining + 1` refused). Return it with
   * {@link rollbackDelegatedCap} on the child's revocation or expiry. When no
   * budget is configured (unlimited), this is a no-op.
   */
  reserveDelegatedCap(sats: number): void {
    if (!Number.isInteger(sats) || sats <= 0) {
      throw new L402Error("reserveDelegatedCap: sats must be a positive integer");
    }
    if (this.budget) {
      try {
        this.budget.reserveTotal("sat", sats);
      } catch (err) {
        throw new L402BudgetError(err instanceof Error ? err.message : String(err));
      }
    } else if (this.budgetSats !== Infinity) {
      if (this.spentSats + sats > this.budgetSats) {
        throw new L402BudgetError(
          `Delegated cap ${sats} sats exceeds remaining budget ${this.remainingBudget}`,
        );
      }
      this.spentSats += sats;
    }
  }

  /** Return a delegated-cap reservation to the budget (child revoked/expired). */
  rollbackDelegatedCap(sats: number): void {
    if (!Number.isInteger(sats) || sats <= 0) return;
    if (this.budget) this.budget.rollback("sat", sats);
    else if (this.budgetSats !== Infinity) this.spentSats = Math.max(0, this.spentSats - sats);
  }

  /** Return a snapshot of all cached session tokens. */
  getSessions(): Map<string, SessionInfo> {
    return new Map(this.store.entries());
  }

  /** Remove all cached session tokens. */
  clearSessions(): void {
    this.store.clear();
  }

  /**
   * Serialize this client's payment receipts (requires a configured
   * `receiptStore`). JSON by default; CSV per the receipt schema's column
   * order; `redact` strips preimages for shareable expense reports.
   * Throws {@link L402Error} when no receipt store was configured.
   */
  exportReceipts(opts: { from?: Date; to?: Date; format?: "json" | "csv"; redact?: boolean } = {}): string {
    if (!this.receiptStore) {
      throw new L402Error(
        "exportReceipts: no receiptStore configured — pass one (e.g. new FileReceiptStore()) to the L402Client constructor",
      );
    }
    return exportReceipts(this.receiptStore.list({ from: opts.from, to: opts.to }), {
      format: opts.format,
      redact: opts.redact,
    });
  }

  /** Convenience wrapper around {@link request} with `method: "GET"`. */
  async get(url: string, options?: L402RequestOptions): Promise<Response> {
    return this.request(url, { ...options, method: "GET" });
  }

  /** Convenience wrapper around {@link request} with `method: "POST"`. */
  async post(url: string, options?: L402RequestOptions): Promise<Response> {
    return this.request(url, { ...options, method: "POST" });
  }

  /**
   * Drop the cached prepaid-credit credential for `url`'s provider (e.g. after
   * revoking its grant, so the client stops presenting a dead token). Returns
   * true if one was cached.
   */
  dropCreditCredential(url: string): boolean {
    return this.creditStore.delete(this.getHostKey(url));
  }

  /**
   * Return the active prepaid-credit credential held for `url`'s provider
   * (`{ macaroon, preimage }`), or `undefined` if none is cached or it has
   * expired. This is the multi-use L402 credential a caller delegates: hand
   * `macaroon` to {@link attenuate} to mint a scoped child, then give the child
   * macaroon plus this same `preimage` to a sub-agent. Credit is tenant-scoped
   * (per host), so a credential bought for the provider is delegable for any of
   * its endpoints. A single-payment per_request credential is spent in the same
   * request it's minted, so there is nothing cached to delegate — buy credit
   * first.
   */
  getCreditCredential(url: string): { macaroon: string; preimage: string } | undefined {
    const key = this.getHostKey(url);
    const credit = this.creditStore.get(key);
    if (!credit) return undefined;
    if (credit.expiresAt <= Date.now()) {
      this.creditStore.delete(key);
      return undefined;
    }
    return { macaroon: credit.macaroon, preimage: credit.preimage };
  }

  /**
   * @deprecated Prepaid bundles are retired. Pay per call, or use prepaid
   * credit (cross-endpoint prepayment) when it lands. This method now throws
   * and pays nothing.
   */
  async buyBundle(): Promise<never> {
    throw new L402Error(
      "buyBundle is retired: pay per call, or use prepaid credit for cross-endpoint " +
        "prepayment. See https://docs.bolthub.ai/docs/sdks/pay",
    );
  }

  /** Drop all cached prepaid-credit credentials. */
  clearCredits(): void {
    this.creditStore.clear();
  }

  /**
   * Buy prepaid credit for a provider: pay once for `creditSats` of credit
   * (face-value — the server charges exactly that, there are no discount
   * tiers), then subsequent {@link request} calls to ANY of that provider's
   * endpoints draw the budget instead of paying, until it's spent. Credit is
   * tenant-scoped, so it's cached and reused per host.
   *
   * Sends an `X-Bolthub-Credit: <creditSats>` request, verifies the server
   * honored the exact budget, pays the credit invoice (enforcing the budget and
   * `maxCostSats`), and caches the credential by host. Throws {@link L402Error}
   * if the provider did not answer with a credit challenge, or did not echo the
   * requested budget — nothing is paid in either case.
   */
  async buyCredit(
    url: string,
    creditSats: number,
    options: L402RequestOptions = {},
  ): Promise<{ creditSats: number; host: string }> {
    if (!Number.isInteger(creditSats) || creditSats <= 0) {
      throw new L402Error("buyCredit: creditSats must be a positive integer");
    }
    const { params, maxCostSats, onPaid, ...fetchOptions } = options;
    let finalUrl = url;
    if (params) finalUrl = `${url}?${new URLSearchParams(params).toString()}`;

    const headers = new Headers(fetchOptions.headers);
    headers.set("X-Bolthub-Credit", String(creditSats));

    this.onStage?.("invoice");
    const challengeResp = await this.fetchRetrying429(
      () => fetch(finalUrl, { ...fetchOptions, headers, signal: AbortSignal.timeout(this.timeoutMs) }),
      fetchOptions.body,
    );
    if (challengeResp.status !== 402) {
      // The gateway refuses a credit request it can't honor with a structured
      // non-402 (e.g. prepaid credit not enabled for this provider) — surface
      // its message.
      let detail = "";
      try {
        detail = ((await challengeResp.clone().json()) as { error?: string })?.error ?? "";
      } catch {
        /* non-JSON body */
      }
      throw new L402Error(
        `buyCredit: provider did not offer prepaid credit (HTTP ${challengeResp.status}${detail ? `: ${detail}` : ""})`,
      );
    }

    // SECURITY: the server is the authority on the honored budget. An HONORED
    // credit challenge echoes `creditSats` in the 402 body, equal to the
    // face-value budget requested. No echo (or a different value) means the
    // server did not open credit for this amount — paying it and caching it as
    // credit would be a phantom purchase that silently reverts to per-call
    // payment. Refuse BEFORE the wallet is ever touched.
    let echoedCredit: number | undefined;
    try {
      const body = (await challengeResp.clone().json()) as { creditSats?: number };
      if (typeof body?.creditSats === "number") echoedCredit = body.creditSats;
    } catch {
      /* non-JSON body: treated as no echo */
    }
    if (echoedCredit !== creditSats) {
      throw new L402Error(
        echoedCredit === undefined
          ? "buyCredit: the server did not honor the credit request (no creditSats in the challenge) — prepaid credit may not be enabled for this provider; nothing was paid"
          : `buyCredit: the server honored ${echoedCredit} sats of credit, not the ${creditSats} requested; nothing was paid`,
      );
    }

    const challenge = this.parseChallenge(challengeResp);
    if (!challenge) throw new L402Error("buyCredit: failed to parse the credit challenge");

    const amount = await this.extractAmount(challengeResp, challenge.invoice);
    const charge = this.resolveCharge(amount, maxCostSats);
    this.reserveCharge(charge);

    this.onStage?.("paying");
    let preimage: string;
    try {
      ({ preimage } = await this.payInvoiceWithRetry(challenge.invoice));
    } catch (err) {
      this.rollbackCharge(charge);
      throw new L402PaymentError(err instanceof Error ? err.message : "Payment failed", { cause: err });
    }

    const host = this.getHostKey(finalUrl);
    this.creditStore.set(host, {
      macaroon: challenge.macaroon,
      preimage,
      expiresAt: Date.now() + CREDIT_CREDENTIAL_TTL_MS,
    });

    const paidInfo = {
      scheme: "l402" as const,
      amount: charge,
      asset: "sat" as const,
      resource: finalUrl,
      preimage,
      invoice: challenge.invoice,
      paymentHash: await this.extractPaymentHash(challengeResp),
    };
    this.onPaid?.(paidInfo);
    onPaid?.(paidInfo);
    this.recordReceipt(paidInfo, fetchOptions.method, challengeResp);
    this.onStage?.("loading");

    return { creditSats, host };
  }

  /**
   * Fetch several URLs, collapsing the Lightning payments to ONE per provider.
   * URLs are grouped by settlement group (host); for each group without cached
   * credit, `creditSats` of credit is bought once, then every URL is fetched
   * concurrently (bounded by `concurrency`, default 6) drawing that credit.
   *
   * Non-custodial by construction: N providers means N payments, never one
   * pooled balance. Provide `creditSats` sized to cover the calls you expect to
   * make to each provider (sum their per-call prices, with headroom). Unused
   * credit at expiry is non-refundable, so size it to expected use.
   */
  async batchFetch(
    urls: string[],
    options: { creditSats: number; concurrency?: number } & L402RequestOptions,
  ): Promise<Response[]> {
    const { creditSats, concurrency = 6, ...reqOptions } = options;
    // One credit purchase per host that doesn't already hold credit.
    const hosts = [...new Set(urls.map((u) => this.getHostKey(u)))];
    for (const host of hosts) {
      const held = this.creditStore.get(host);
      if (!held || held.expiresAt <= Date.now()) {
        // Buy against the first URL for this host (any endpoint mints the credit).
        const seed = urls.find((u) => this.getHostKey(u) === host)!;
        await this.buyCredit(seed, creditSats, reqOptions);
      }
    }
    // Fetch all URLs, bounded concurrency; each draws its host's credit.
    const results = new Array<Response>(urls.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= urls.length) return;
        results[i] = await this.request(urls[i], reqOptions);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
    return results;
  }

  /**
   * Send an HTTP request, automatically handling L402 challenges.
   *
   * If the server responds with 402 the client will parse the challenge,
   * pay the invoice, and retry with the L402 proof. Throws
   * {@link L402BudgetError} if the invoice exceeds configured limits and
   * {@link L402PaymentError} if the wallet fails to pay.
   */
  async request(url: string, options: L402RequestOptions = {}): Promise<Response> {
    const { params, maxCostSats, onPaid, ...fetchOptions } = options;

    let finalUrl = url;
    if (params) {
      const searchParams = new URLSearchParams(params);
      finalUrl = `${url}?${searchParams.toString()}`;
    }

    const sessionKey = this.getSessionKey(finalUrl);

    // Prepaid credit: if a credit credential is cached for this host, present it
    // (draws the prepaid budget, no payment) on ANY of the provider's
    // endpoints. A 402 means the credit is spent — drop it and fall through to
    // the normal session / single-use flow.
    const creditKey = this.getHostKey(finalUrl);
    const credit = this.creditStore.get(creditKey);
    if (credit && credit.expiresAt > Date.now()) {
      const headers = new Headers(fetchOptions.headers);
      headers.set("Authorization", `L402 ${credit.macaroon}:${credit.preimage}`);
      try {
        const resp = await this.fetchRetryingUpstream(
          () => fetch(finalUrl, { ...fetchOptions, headers, signal: AbortSignal.timeout(this.timeoutMs) }),
          fetchOptions.body,
          finalUrl,
        );
        if (resp.status !== 402) return resp;
        this.creditStore.delete(creditKey);
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new L402TimeoutError("Request timed out");
        }
        throw err;
      }
    } else if (credit) {
      this.creditStore.delete(creditKey); // expired
    }

    const existingSession = this.store.get(sessionKey);

    if (existingSession && existingSession.expiresAt > Date.now()) {
      const headers = new Headers(fetchOptions.headers);
      headers.set("X-Session-Token", existingSession.token);

      try {
        const resp = await this.fetchRetryingUpstream(
          () =>
            fetch(finalUrl, {
              ...fetchOptions,
              headers,
              signal: AbortSignal.timeout(this.timeoutMs),
            }),
          fetchOptions.body,
          finalUrl,
        );

        if (resp.status !== 402) {
          this.updateSessionFromResponse(sessionKey, resp);
          return resp;
        }
        this.store.delete(sessionKey);
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new L402TimeoutError("Request timed out");
        }
        throw err;
      }
    }

    this.onStage?.("invoice");

    let resp: Response;
    try {
      resp = await this.fetchRetrying429(
        () =>
          fetch(finalUrl, {
            ...fetchOptions,
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        fetchOptions.body,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new L402TimeoutError("Request timed out waiting for the endpoint to respond");
      }
      throw err;
    }

    if (resp.status !== 402) {
      return resp;
    }

    const challenge = this.parseChallenge(resp);
    if (!challenge) {
      // A 402 without a parseable challenge is usually a STRUCTURED REFUSAL
      // of a presented credential (bundle_exhausted / bundle_expired /
      // token_revoked / not_bundle_backed), not a malformed challenge —
      // surface the server's own code and message so an agent gets the
      // deterministic "stop, don't retry" answer instead of a parse error.
      let refusal = "";
      try {
        const body = (await resp.clone().json()) as { error?: string; code?: string };
        if (body?.error) refusal = body.code ? `${body.error} [${body.code}]` : body.error;
      } catch {
        /* non-JSON body */
      }
      throw new L402Error(
        refusal
          ? `Payment refused: ${refusal}`
          : "Failed to parse L402 challenge from 402 response",
      );
    }

    const amountSats = await this.extractAmount(resp, challenge.invoice);

    // Resolve the charge (enforcing per-request, total-budget, and the
    // unknown-amount policy), then RESERVE it synchronously — before the
    // `await` below — so concurrent requests can never both pass the budget
    // check and overspend. Roll back the reservation if payment fails.
    const charge = this.resolveCharge(amountSats, maxCostSats);
    this.reserveCharge(charge);

    this.onStage?.("paying");

    let preimage: string;
    try {
      const result = await this.payInvoiceWithRetry(challenge.invoice);
      preimage = result.preimage;
    } catch (err) {
      this.rollbackCharge(charge);
      throw new L402PaymentError(
        err instanceof Error ? err.message : "Payment failed",
        { cause: err },
      );
    }

    const paidInfo = {
      scheme: "l402" as const,
      amount: charge,
      asset: "sat" as const,
      resource: finalUrl,
      preimage,
      invoice: challenge.invoice,
      paymentHash: await this.extractPaymentHash(resp),
    };
    this.onPaid?.(paidInfo);
    onPaid?.(paidInfo);
    this.onStage?.("loading");

    const headers = new Headers(fetchOptions.headers);
    headers.set("Authorization", `L402 ${challenge.macaroon}:${preimage}`);

    try {
      // A 429 here is retried with the SAME L402 proof: the gateway
      // reverts the invoice consumption when it answers 429, so the
      // retry re-uses the payment already made above. The same holds for
      // origin failures the gateway reports as upstream_failed_retryable.
      const authedResp = await this.fetchRetryingUpstream(
        () =>
          fetch(finalUrl, {
            ...fetchOptions,
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        fetchOptions.body,
        finalUrl,
      );

      this.updateSessionFromResponse(sessionKey, authedResp);
      this.recordReceipt(paidInfo, fetchOptions.method, authedResp);

      return authedResp;
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new L402TimeoutError("Request timed out loading the response after payment");
      }
      throw err;
    }
  }

  /** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms. */
  private parseRetryAfterMs(resp: Response): number | null {
    const raw = resp.headers.get("Retry-After");
    if (!raw) return null;
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  /**
   * Run one fetch attempt, waiting out up to `rateLimitRetries` 429
   * answers. Each attempt calls `doFetch` again so timeout signals are
   * fresh. A 429 whose wait would exceed `maxRetryAfterMs` — or whose
   * request body is a non-replayable stream — is returned as-is.
   */
  private async fetchRetrying429(
    doFetch: () => Promise<Response>,
    body: BodyInit | null | undefined,
  ): Promise<Response> {
    let resp = await doFetch();
    if (this.rateLimitRetries === 0 || body instanceof ReadableStream) return resp;
    for (let attempt = 1; attempt <= this.rateLimitRetries && resp.status === 429; attempt++) {
      const waitMs = this.parseRetryAfterMs(resp) ?? 1000 * 2 ** (attempt - 1);
      if (waitMs > this.maxRetryAfterMs) return resp;
      await new Promise((r) => setTimeout(r, waitMs));
      resp = await doFetch();
    }
    return resp;
  }

  /**
   * Run a credentialed fetch (429-aware via {@link fetchRetrying429}),
   * then wait out gateway-signaled upstream failures. When the response
   * carries `X-Bolthub-Payment-Code: upstream_failed_retryable` the
   * payment layer already un-charged the request — the held credential
   * re-redeems for free — so the identical request is re-sent with
   * jittered backoff (250ms, 500ms, …), up to `upstreamRetries` times.
   * Strictly signal-gated: a bare 5xx without the header is returned
   * untouched. Stream bodies are never retried (not re-readable).
   */
  private async fetchRetryingUpstream(
    doFetch: () => Promise<Response>,
    body: BodyInit | null | undefined,
    resource: string,
  ): Promise<Response> {
    let resp = await this.fetchRetrying429(doFetch, body);
    let attempts = 1;
    const active =
      this.retryOnUpstreamFailure && this.upstreamRetries > 0 && !(body instanceof ReadableStream);
    if (active) {
      for (let attempt = 1; attempt <= this.upstreamRetries; attempt++) {
        if (readPaymentStatus(resp.headers)?.code !== "upstream_failed_retryable") break;
        await new Promise((r) =>
          setTimeout(r, 250 * 2 ** (attempt - 1) + Math.random() * 100),
        );
        resp = await this.fetchRetrying429(doFetch, body);
        attempts++;
      }
    }
    if (this.throwOnUpstreamFailure) {
      const status = readPaymentStatus(resp.headers);
      if (status?.code === "upstream_failed_retryable") {
        throw new UpstreamFailedError(
          `Upstream failed (HTTP ${resp.status}) after ${attempts} attempt(s); ` +
            `payment ${status.state} — retrying later is free`,
          { paymentStatus: status, httpStatus: resp.status, attempts, resource },
        );
      }
    }
    return resp;
  }

  /**
   * Pay an invoice, retrying transient wallet failures with exponential
   * backoff (500ms, 1s, 2s, …). Retries re-attempt the same BOLT11
   * invoice, which the network settles at most once — a retry after an
   * ambiguous failure cannot double-pay.
   */
  private async payInvoiceWithRetry(invoice: string): Promise<{ preimage: string }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.payRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
      try {
        return await this.wallet.payInvoice(invoice);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private getSessionKey(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  // Prepaid credit is scoped to the settlement group; today that is the gateway
  // host (one host = one tenant). Credentials are cached and grouped by it.
  private getHostKey(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  private updateSessionFromResponse(sessionKey: string, resp: Response): void {
    const sessionToken = resp.headers.get("X-Session-Token");
    if (!sessionToken) return;

    const expiresStr = resp.headers.get("X-Session-Expires");
    const balanceStr = resp.headers.get("X-Session-Balance");

    const expiresAt = expiresStr
      ? new Date(expiresStr).getTime()
      : Date.now() + 3600_000;

    const balance = balanceStr ? parseInt(balanceStr, 10) : undefined;

    if (balance !== undefined && balance <= 0) {
      this.store.delete(sessionKey);
      return;
    }

    this.store.set(sessionKey, {
      token: sessionToken,
      expiresAt: isNaN(expiresAt) ? Date.now() + 3600_000 : expiresAt,
      balance,
    });
  }

  private parseChallenge(resp: Response): L402Challenge | null {
    const wwwAuth = resp.headers.get("WWW-Authenticate");
    if (!wwwAuth) return null;

    // Accept both the historical `macaroon=` field and the token-agnostic
    // `token=` the L402 spec is renaming toward (bLIP-0026). `macaroon=`
    // wins when both are present, so today's gateways behave identically;
    // `token=` is a forward-compatible fallback. The credential is opaque
    // either way (parsed out and echoed back in the Authorization header).
    const credentialMatch =
      wwwAuth.match(/macaroon="([^"]+)"/) ?? wwwAuth.match(/\btoken="([^"]+)"/);
    const invoiceMatch = wwwAuth.match(/invoice="([^"]+)"/);

    if (!credentialMatch || !invoiceMatch) return null;

    return {
      macaroon: credentialMatch[1],
      invoice: invoiceMatch[1],
    };
  }

  /**
   * Record one receipt per settled payment (opt-in: no store, no write).
   * `outcome` is the gateway's X-Bolthub-Payment header when emitted; the
   * store fills payment_hash from the preimage when the 402 body lacked it.
   * A store failure is surfaced as a warning, never as a failed request:
   * the paid call already succeeded.
   */
  private recordReceipt(
    paidInfo: { amount: number; resource: string; preimage?: string; invoice?: string; paymentHash?: string },
    method: string | undefined,
    resp: Response,
  ): void {
    if (!this.receiptStore) return;
    try {
      this.receiptStore.append({
        receipt_v: 1,
        ts: new Date().toISOString(),
        resource: paidInfo.resource,
        method: (method ?? "GET").toUpperCase(),
        amount_sats: paidInfo.amount,
        payment_hash: paidInfo.paymentHash ?? "",
        preimage: paidInfo.preimage ?? "",
        invoice: paidInfo.invoice ?? "",
        outcome: resp.headers.get("X-Bolthub-Payment") ?? "unknown",
      });
    } catch (err) {
      console.error(`bolthub: failed to record payment receipt: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Read the payment hash from the 402 body (`paymentHash`, present on
   * bolthub gateways). Optional receipt metadata: callers can always derive
   * it as sha256(preimage) when absent.
   */
  private async extractPaymentHash(resp: Response): Promise<string | undefined> {
    try {
      const hash = ((await resp.clone().json()) as { paymentHash?: unknown })?.paymentHash;
      return typeof hash === "string" && hash.length > 0 ? hash : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the invoice price in sats from the available sources, in priority
   * order: body `amountSats` -> decoded BOLT11 invoice -> `priceHeader`.
   * Returns `null` when no source yields a positive amount.
   */
  private async extractAmount(resp: Response, invoice: string): Promise<number | null> {
    let bodyAmount: unknown;
    try {
      bodyAmount = (await resp.clone().json())?.amountSats;
    } catch {
      bodyAmount = undefined;
    }
    if (typeof bodyAmount === "number" && bodyAmount > 0) return Math.floor(bodyAmount);

    const fromInvoice = bolt11AmountSats(invoice);
    if (fromInvoice !== null && fromInvoice > 0) return fromInvoice;

    if (this.priceHeader) {
      const raw = resp.headers.get(this.priceHeader);
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  /**
   * The per-request ceiling for one call: `maxPerRequestSats`, tightened by
   * the shared budget's `maxPerCall.sat` (when an external budget is set) and
   * by the caller's one-off `maxCostSats`. Never looser than any of them.
   */
  private effectivePerRequestCap(maxCostSats?: number): number {
    return Math.min(
      this.maxPerRequestSats,
      this.budget?.perCallFor("sat") ?? Infinity,
      maxCostSats ?? Infinity,
    );
  }

  /**
   * Validate an invoice's charge against the per-request limit, the total
   * budget, and the unknown-amount policy. Returns the sats to count; throws
   * {@link L402BudgetError} when a limit is exceeded or the policy refuses.
   */
  private resolveCharge(amount: number | null, maxCostSats?: number): number {
    const cap = this.effectivePerRequestCap(maxCostSats);
    if (amount === null) {
      if (this.onUnknownAmount === "allow") return 0;
      if (this.onUnknownAmount === "refuse") {
        throw new L402BudgetError(
          "Invoice amount could not be determined; refusing to pay (onUnknownAmount='refuse')"
        );
      }
      // "cap": pay only up to the per-request ceiling (counted); refuse if unset.
      if (cap === Infinity) {
        throw new L402BudgetError(
          "Invoice amount could not be determined and no maxPerRequestSats is set; refusing to pay"
        );
      }
      this.checkBudget(cap);
      return cap;
    }
    if (amount > cap) {
      throw new L402BudgetError(
        `Invoice amount ${amount} sats exceeds per-request limit of ${cap} sats`
      );
    }
    this.checkBudget(amount);
    return amount;
  }

  private checkBudget(charge: number): void {
    if (this.budget) {
      const denial = this.budget.check("sat", charge);
      if (denial) {
        throw new L402BudgetError(
          `Invoice amount ${charge} sats ${denial} (spent: ${this.budget.spentFor("sat")}, remaining: ${this.budget.remainingFor("sat")})`
        );
      }
      return;
    }
    if (this.spentSats + charge > this.budgetSats) {
      throw new L402BudgetError(
        `Invoice amount ${charge} sats would exceed total budget (spent: ${this.spentSats}, budget: ${this.budgetSats})`
      );
    }
  }

  /**
   * Take the reservation resolved by {@link resolveCharge} — synchronously,
   * before the payment `await`. A zero charge (unknown-amount "allow") is
   * never counted.
   */
  private reserveCharge(charge: number): void {
    if (charge <= 0) return;
    if (this.budget) {
      try {
        this.budget.reserve("sat", charge);
      } catch (err) {
        throw new L402BudgetError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    this.spentSats += charge;
  }

  private rollbackCharge(charge: number): void {
    if (charge <= 0) return;
    if (this.budget) this.budget.rollback("sat", charge);
    else this.spentSats -= charge;
  }
}

/** Base error for all L402-related failures. */
export class L402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L402Error";
  }
}

/** Thrown when an invoice exceeds per-request or total budget limits. */
export class L402BudgetError extends L402Error {
  constructor(message: string) {
    super(message);
    this.name = "L402BudgetError";
  }
}

/** Thrown when an HTTP request times out. */
export class L402TimeoutError extends L402Error {
  constructor(message: string) {
    super(message);
    this.name = "L402TimeoutError";
  }
}

/** Thrown when the wallet adapter fails to pay an invoice. */
export class L402PaymentError extends L402Error {
  public readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "L402PaymentError";
    this.cause = options?.cause;
  }
}

/**
 * Thrown (opt-in via `throwOnUpstreamFailure`) when the origin kept
 * failing after payment and all free retries were exhausted. The gateway
 * already un-charged the request — `paymentStatus` says how (invoice
 * reverted or deduction refunded) — so retrying later costs nothing;
 * `retryable` is always true for this error.
 */
export class UpstreamFailedError extends L402Error {
  public readonly retryable = true;
  public readonly paymentStatus: PaymentStatus;
  public readonly httpStatus: number;
  public readonly attempts: number;
  public readonly resource: string;
  constructor(
    message: string,
    details: { paymentStatus: PaymentStatus; httpStatus: number; attempts: number; resource: string },
  ) {
    super(message);
    this.name = "UpstreamFailedError";
    this.paymentStatus = details.paymentStatus;
    this.httpStatus = details.httpStatus;
    this.attempts = details.attempts;
    this.resource = details.resource;
  }
}

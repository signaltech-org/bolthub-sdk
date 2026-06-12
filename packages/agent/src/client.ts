import type { L402ClientOptions, L402Challenge, L402RequestOptions, WalletAdapter } from "./types";
import type { SessionStore, SessionData } from "./session-store";

/** Lifecycle stage reported via {@link L402ClientOptions.onStage}. */
export type L402Stage = "invoice" | "paying" | "loading";

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
  private timeoutMs: number;
  private payRetries: number;
  private spentSats = 0;
  private onStage?: (stage: L402Stage) => void;
  private store: SessionStore;

  constructor(options: L402ClientOptions) {
    this.wallet = options.wallet;
    this.maxPerRequestSats = options.maxPerRequestSats ?? Infinity;
    this.budgetSats = options.budgetSats ?? Infinity;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.payRetries = options.payRetries ?? 2;
    this.onStage = options.onStage;
    this.store = options.sessionStore ?? new InMemorySessionStore();
  }

  /** Total satoshis spent across all requests since construction. */
  get totalSpent(): number {
    return this.spentSats;
  }

  /** Satoshis remaining before the client refuses to pay further invoices. */
  get remainingBudget(): number {
    return Math.max(0, this.budgetSats - this.spentSats);
  }

  /** Return a snapshot of all cached session tokens. */
  getSessions(): Map<string, SessionInfo> {
    return new Map(this.store.entries());
  }

  /** Remove all cached session tokens. */
  clearSessions(): void {
    this.store.clear();
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
   * Send an HTTP request, automatically handling L402 challenges.
   *
   * If the server responds with 402 the client will parse the challenge,
   * pay the invoice, and retry with the L402 proof. Throws
   * {@link L402BudgetError} if the invoice exceeds configured limits and
   * {@link L402PaymentError} if the wallet fails to pay.
   */
  async request(url: string, options: L402RequestOptions = {}): Promise<Response> {
    const { params, ...fetchOptions } = options;

    let finalUrl = url;
    if (params) {
      const searchParams = new URLSearchParams(params);
      finalUrl = `${url}?${searchParams.toString()}`;
    }

    const sessionKey = this.getSessionKey(finalUrl);
    const existingSession = this.store.get(sessionKey);

    if (existingSession && existingSession.expiresAt > Date.now()) {
      const headers = new Headers(fetchOptions.headers);
      headers.set("X-Session-Token", existingSession.token);

      try {
        const resp = await fetch(finalUrl, {
          ...fetchOptions,
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

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
      resp = await fetch(finalUrl, {
        ...fetchOptions,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
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
      throw new L402Error("Failed to parse L402 challenge from 402 response");
    }

    const amountSats = await this.extractAmount(resp);
    if (amountSats !== null) {
      if (amountSats > this.maxPerRequestSats) {
        throw new L402BudgetError(
          `Invoice amount ${amountSats} sats exceeds per-request limit of ${this.maxPerRequestSats} sats`
        );
      }
      if (this.spentSats + amountSats > this.budgetSats) {
        throw new L402BudgetError(
          `Invoice amount ${amountSats} sats would exceed total budget (spent: ${this.spentSats}, budget: ${this.budgetSats})`
        );
      }
    }

    this.onStage?.("paying");

    let preimage: string;
    try {
      const result = await this.payInvoiceWithRetry(challenge.invoice);
      preimage = result.preimage;
    } catch (err) {
      throw new L402PaymentError(
        err instanceof Error ? err.message : "Payment failed",
        { cause: err },
      );
    }

    if (amountSats !== null) {
      this.spentSats += amountSats;
    }

    this.onStage?.("loading");

    const headers = new Headers(fetchOptions.headers);
    headers.set("Authorization", `L402 ${challenge.macaroon}:${preimage}`);

    try {
      const authedResp = await fetch(finalUrl, {
        ...fetchOptions,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      this.updateSessionFromResponse(sessionKey, authedResp);

      return authedResp;
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new L402TimeoutError("Request timed out loading the response after payment");
      }
      throw err;
    }
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

    const macaroonMatch = wwwAuth.match(/macaroon="([^"]+)"/);
    const invoiceMatch = wwwAuth.match(/invoice="([^"]+)"/);

    if (!macaroonMatch || !invoiceMatch) return null;

    return {
      macaroon: macaroonMatch[1],
      invoice: invoiceMatch[1],
    };
  }

  private async extractAmount(resp: Response): Promise<number | null> {
    try {
      const body = await resp.clone().json();
      return typeof body.amountSats === "number" ? body.amountSats : null;
    } catch {
      return null;
    }
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

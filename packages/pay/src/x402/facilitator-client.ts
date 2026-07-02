/**
 * HTTP client for the standard x402 facilitator API — the concrete
 * {@link FacilitatorClient} that {@link x402Rail} delegates verify/settle to.
 *
 * Speaks the wire format of the reference facilitators (`x402.org/facilitator`
 * for Base Sepolia, Coinbase CDP for mainnet, or a self-hosted one):
 *
 *   POST {url}/verify  { x402Version, paymentPayload, paymentRequirements }
 *     → { isValid, invalidReason?, payer? }
 *   POST {url}/settle  (same body)
 *     → { success, errorReason?, transaction?/txHash?, network? }
 *
 * Auth is injected: pass static `headers`, or an async `authHeaders` hook for
 * per-request tokens (e.g. CDP's JWT scheme). Transport failures surface as
 * invalid/failed results (never thrown), so a facilitator outage degrades to
 * "payment not accepted" instead of crashing the tool.
 */

import type { FacilitatorClient, X402PaymentPayload, X402Requirements } from "../rails/x402";

export interface X402FacilitatorOptions {
  /** Facilitator base URL, e.g. `https://x402.org/facilitator`. `/verify` and `/settle` are appended. */
  url: string;
  /** Static headers sent with every request (e.g. an API key). */
  headers?: Record<string, string>;
  /** Per-request auth hook; merged over `headers`. Use for short-lived JWTs (CDP). */
  authHeaders?: (path: "verify" | "settle") => Promise<Record<string, string>>;
  /** x402 protocol version sent in request bodies. Default 1. */
  x402Version?: number;
  /** Injected fetch, for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Build a {@link FacilitatorClient} over the standard x402 facilitator HTTP API. */
export function x402Facilitator(options: X402FacilitatorOptions): FacilitatorClient {
  if (!options.url) throw new Error("x402Facilitator: `url` is required");
  const base = options.url.endsWith("/") ? options.url.slice(0, -1) : options.url;
  const x402Version = options.x402Version ?? 1;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function post(
    path: "verify" | "settle",
    payment: X402PaymentPayload,
    requirements: X402Requirements,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...options.headers,
      ...(options.authHeaders ? await options.authHeaders(path) : undefined),
    };
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          x402Version,
          paymentPayload: payment,
          paymentRequirements: requirements,
        }),
      });
    } catch (err) {
      return { ok: false, reason: `facilitator ${path} unreachable: ${(err as Error).message}` };
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `facilitator ${path} returned non-JSON (HTTP ${res.status})` };
    }
    if (!res.ok) {
      const detail = typeof body.error === "string" ? body.error : JSON.stringify(body);
      return { ok: false, reason: `facilitator ${path} HTTP ${res.status}: ${detail}` };
    }
    return { ok: true, body };
  }

  return {
    async verify(payment, requirements) {
      const res = await post("verify", payment, requirements);
      if (!res.ok) return { isValid: false, invalidReason: res.reason };
      return {
        isValid: res.body.isValid === true,
        invalidReason: typeof res.body.invalidReason === "string" ? res.body.invalidReason : undefined,
        payer: typeof res.body.payer === "string" ? res.body.payer : undefined,
      };
    },

    async settle(payment, requirements) {
      const res = await post("settle", payment, requirements);
      if (!res.ok) return { success: false, errorReason: res.reason };
      // Reference implementations have shipped both `transaction` and `txHash`.
      const tx = res.body.transaction ?? res.body.txHash;
      return {
        success: res.body.success === true,
        txHash: typeof tx === "string" ? tx : undefined,
        errorReason: typeof res.body.errorReason === "string" ? res.body.errorReason : undefined,
      };
    },
  };
}

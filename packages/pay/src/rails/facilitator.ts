/**
 * The SDK→facilitator bridge (seller side).
 *
 * `facilitatorRail` is a {@link PaymentRail} that delegates minting and
 * verification to a **hosted bolthub facilitator** instead of computing them
 * locally. Swap `l402Rail({ secret, invoiceProvider })` for
 * `facilitatorRail({ scheme, assets, transport })` and the same `paywall()` now
 * runs on the hosted path — bolthub sits in the metering/control flow (replay
 * protection, usage analytics, discovery) but never in the funds path.
 *
 * See `docs/specs/facilitator-protocol-v0.md` and
 * `docs/transition/roles-and-topology.md`.
 */

import type { Offer, PaymentRail, Price, ResourceRef, VerifyResult } from "../types";

/** A mint request sent to the facilitator. */
export interface MintRequest {
  scheme: string;
  resource: ResourceRef;
  price: Required<Price>;
}

/** A verify request sent to the facilitator. */
export interface VerifyRequest {
  scheme: string;
  resource: ResourceRef;
  price: Required<Price>;
  proof: string;
}

/**
 * Transport to a hosted facilitator. `httpFacilitator` is the production
 * implementation; tests/embedded use can supply an in-process one.
 */
export interface FacilitatorTransport {
  mint(req: MintRequest): Promise<Offer>;
  verify(req: VerifyRequest): Promise<VerifyResult>;
}

export interface FacilitatorRailOptions {
  /** Scheme this rail settles via the facilitator, e.g. `"l402"`. */
  scheme: string;
  /** Assets the scheme settles, e.g. `["sat"]`. */
  assets: string[];
  /** Transport to the facilitator. */
  transport: FacilitatorTransport;
}

/** Build a {@link PaymentRail} that delegates to a hosted facilitator. */
export function facilitatorRail(options: FacilitatorRailOptions): PaymentRail {
  if (!options.assets || options.assets.length === 0) {
    throw new Error("facilitatorRail: `assets` must be non-empty");
  }
  return {
    scheme: options.scheme,
    assets: options.assets,
    createOffer: (price: Required<Price>, resource: ResourceRef): Promise<Offer> =>
      options.transport.mint({ scheme: options.scheme, resource, price }),
    verify: (proof: string, ctx: { resource: ResourceRef; price: Required<Price> }): Promise<VerifyResult> =>
      options.transport.verify({ scheme: options.scheme, resource: ctx.resource, price: ctx.price, proof }),
  };
}

export interface HttpFacilitatorOptions {
  /**
   * Facilitator base URL. Endpoints are resolved *relative* to it, so the
   * facilitator can be mounted under any prefix — `https://facilitator.bolthub.ai`
   * hits `/v1/mint`; `https://api.bolthub.ai/facilitator` hits `/facilitator/v1/mint`.
   */
  baseUrl: string;
  /** Seller API key (issued in the bolthub dashboard). */
  apiKey: string;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** A {@link FacilitatorTransport} that talks to a facilitator over HTTP. */
export function httpFacilitator(options: HttpFacilitatorOptions): FacilitatorTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
  const post = async <T>(op: string, body: unknown): Promise<T> => {
    const res = await doFetch(new URL(`v1/${op}`, base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`facilitator v1/${op} returned ${res.status}`);
    }
    return (await res.json()) as T;
  };
  return {
    async mint(req) {
      const { offer } = await post<{ offer: Offer }>("mint", req);
      return offer;
    },
    async verify(req) {
      return post<VerifyResult>("verify", req);
    },
  };
}

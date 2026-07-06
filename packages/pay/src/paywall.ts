/**
 * The seller wrapper: turn any MCP tool handler into a paid one.
 *
 * `createPaywall({ rails })` returns a `pay(opts, handler)` wrapper. The wrapped
 * handler implements the MCP side of the Tool Payment Profile:
 *
 *   - a call with no valid proof → a `payment_required` challenge (one offer per
 *     rail that can price the tool), carried in `_meta["ai.bolthub/payment"]`
 *     plus a human-readable error so payment-blind clients still see something
 *     sensible;
 *   - a call carrying a valid proof in `extra._meta["ai.bolthub/payment"]` → the
 *     real handler runs.
 *
 * A tool can be priced in more than one asset; each rail is matched to the price
 * whose asset it settles. The wrapper is rail-agnostic: it never touches invoices
 * or signatures; each {@link PaymentRail} mints and verifies its own. See
 * `docs/specs/tool-payment-profile-v0.md`.
 */

import type {
  BillingModel,
  Offer,
  PaymentAdvertisement,
  PaymentChallenge,
  PaymentProof,
  PaymentRail,
  Price,
  ResourceRef,
  ToolExtra,
  ToolHandler,
  ToolResult,
} from "./types";

/** The reverse-DNS `_meta` key that carries TPP challenge/proof envelopes. */
export const PAYMENT_META_KEY = "ai.bolthub/payment";

/** TPP spec version this implementation emits. */
export const SPEC_VERSION = "0.1";

/** Fallback challenge lifetime when no rail reports an offer expiry. */
const FALLBACK_CHALLENGE_TTL_MS = 15 * 60 * 1000;

export interface CreatePaywallOptions {
  /** Settlement rails offered to buyers, in preference order. At least one. */
  rails: PaymentRail[];
  /** Asset assumed when a price omits one. Defaults to `"sat"`. */
  defaultAsset?: string;
  /** Called after a proof verifies and before the handler runs. */
  onPaid?: (info: { resource: ResourceRef; scheme: string; amount?: number }) => void;
}

export interface PaywallToolOptions {
  /** Price for one call. Pass an array to price in several assets (one per rail). */
  price: Price | Price[];
  /**
   * Stable, unique id for the thing being sold (e.g. the tool name). A proof is
   * accepted **only** for the resource it was minted against, so this MUST be
   * set — the wrapper fails closed if it is missing. `createPaywall().tool(...)`
   * fills it in from the tool name for you.
   */
  resource: ResourceRef;
}

/** A handler-wrapping paywall, with a `.tool` registrar and `.advertise` helper. */
export type Paywall = ((opts: PaywallToolOptions, handler: ToolHandler) => ToolHandler) & {
  /**
   * Register a paid tool on an MCP server, defaulting `resource` to `name`.
   * `server` only needs a `tool(name, description, schema, handler)` method, so
   * this stays decoupled from the MCP SDK version.
   */
  tool(
    server: ToolRegistrarServer,
    name: string,
    description: string,
    schema: unknown,
    opts: { price: Price | Price[]; resource?: ResourceRef },
    handler: ToolHandler,
  ): void;
  /** Build the discovery-time {@link PaymentAdvertisement} for a price. */
  advertise(price: Price | Price[], model?: BillingModel): PaymentAdvertisement;
};

interface ToolRegistrarServer {
  tool(name: string, description: string, schema: unknown, handler: ToolHandler): unknown;
}

/** Read and validate the proof envelope from a request's `_meta`. */
function readProof(extra?: ToolExtra): PaymentProof | undefined {
  const raw = extra?._meta?.[PAYMENT_META_KEY] as Partial<PaymentProof> | undefined;
  if (raw && typeof raw.scheme === "string" && typeof raw.proof === "string") {
    return { scheme: raw.scheme, proof: raw.proof };
  }
  return undefined;
}

/** The first price a rail can settle, or undefined if none of them match its assets. */
function priceForRail(rail: PaymentRail, prices: Required<Price>[]): Required<Price> | undefined {
  return prices.find((p) => rail.assets.includes(p.asset));
}

/** Mint a fresh challenge: one offer per rail that can price this resource. */
async function buildChallenge(
  rails: PaymentRail[],
  prices: Required<Price>[],
  resource: ResourceRef,
): Promise<PaymentChallenge> {
  const offers: Offer[] = [];
  for (const rail of rails) {
    const price = priceForRail(rail, prices);
    if (!price) continue; // this rail settles none of the tool's priced assets
    try {
      offers.push(await rail.createOffer(price, resource));
    } catch {
      // A rail that can't mint right now (wallet down, etc.) is omitted rather
      // than failing the whole challenge — other rails may still work.
    }
  }
  if (offers.length === 0) {
    throw new Error(`No configured rail could create an offer for ${resource}`);
  }
  const expiries = offers
    .map((o) => o.expiresAt)
    .filter((e): e is number => typeof e === "number");
  const expiresAt = expiries.length > 0 ? Math.min(...expiries) : Date.now() + FALLBACK_CHALLENGE_TTL_MS;

  // Top-level `price` is the primary (first) price for display; each offer
  // carries its own authoritative amount + asset.
  return { status: "payment_required", version: SPEC_VERSION, price: prices[0], resource, offers, expiresAt };
}

/** Wrap a challenge in an MCP error result (human text + machine-readable `_meta`). */
function challengeResult(challenge: PaymentChallenge, note?: string): ToolResult {
  const text =
    (note ? `${note} ` : "") +
    `Payment required: ${challenge.price.amount} ${challenge.price.asset} to use ` +
    `"${challenge.resource}". Pay one of the ${challenge.offers.length} offered ` +
    `method(s) and retry with the proof in _meta["${PAYMENT_META_KEY}"].`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: { [PAYMENT_META_KEY]: challenge },
  };
}

/** Normalise one-or-many prices, applying the default asset and validating amounts. */
function normalisePrices(price: Price | Price[], defaultAsset: string): Required<Price>[] {
  const list = (Array.isArray(price) ? price : [price]).map((p) => ({
    amount: p.amount,
    asset: p.asset ?? defaultAsset,
  }));
  if (list.length === 0) throw new Error("paywall: at least one price is required");
  for (const p of list) {
    if (!Number.isInteger(p.amount) || p.amount <= 0) {
      throw new Error("paywall: every price.amount must be a positive integer");
    }
  }
  return list;
}

/**
 * Create a paywall bound to one or more {@link PaymentRail}s.
 *
 * @example
 * ```ts
 * const pay = createPaywall({
 *   rails: [l402Rail({ secret, invoiceProvider })],
 * });
 *
 * pay.tool(server, "get_satellite_image", "Recent imagery", schema,
 *          { price: { amount: 2000, asset: "sat" } },
 *          async (args) => fetchImage(args));
 * ```
 */
export function createPaywall(options: CreatePaywallOptions): Paywall {
  if (!options.rails || options.rails.length === 0) {
    throw new Error("createPaywall: at least one rail is required");
  }
  const defaultAsset = options.defaultAsset ?? "sat";
  const railByScheme = new Map(options.rails.map((r) => [r.scheme, r] as const));

  const pay = ((opts: PaywallToolOptions, handler: ToolHandler): ToolHandler => {
    const { resource } = opts;
    if (!resource) {
      throw new Error(
        'paywall: `resource` is required — a stable, unique id for this tool ' +
          '(e.g. its name). Without it, a proof minted for one tool could unlock ' +
          "another. Use createPaywall().tool(...) to default it to the tool name.",
      );
    }
    const prices = normalisePrices(opts.price, defaultAsset);

    return async (args, extra) => {
      const proof = readProof(extra);
      if (!proof) {
        return challengeResult(await buildChallenge(options.rails, prices, resource));
      }
      const rail = railByScheme.get(proof.scheme);
      if (!rail) {
        return challengeResult(
          await buildChallenge(options.rails, prices, resource),
          `Unsupported payment scheme "${proof.scheme}".`,
        );
      }
      const price = priceForRail(rail, prices);
      if (!price) {
        return challengeResult(
          await buildChallenge(options.rails, prices, resource),
          `No price configured for scheme "${proof.scheme}".`,
        );
      }
      const result = await rail.verify(proof.proof, { resource, price });
      if (!result.ok) {
        return challengeResult(
          await buildChallenge(options.rails, prices, resource),
          `Payment proof rejected: ${result.reason}.`,
        );
      }
      options.onPaid?.({ resource, scheme: rail.scheme, amount: result.amount });
      return handler(args, extra);
    };
  }) as Paywall;

  pay.tool = (server, name, description, schema, opts, handler) => {
    server.tool(name, description, schema, pay({ price: opts.price, resource: opts.resource ?? name }, handler));
  };

  pay.advertise = (price, model: BillingModel = "per_call") => {
    const prices = normalisePrices(price, defaultAsset);
    return { version: SPEC_VERSION, price: prices[0], model, rails: options.rails.map((r) => r.scheme) };
  };

  return pay;
}

import type { ApiClient, DirectoryEntry } from "./api-client.js";
import { WALLET_ENV_HINT, readPaymentStatus, attenuate } from "@bolthub/pay";
import type { L402Client, AttenuateOptions } from "@bolthub/pay";
import { auditMint, auditRevoke } from "../telemetry.js";
import {
  clampStreamCaps,
  formatStreamWindow,
  isEventStreamResponse,
  readStreamWindow,
} from "./stream-window.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function budgetSummary(l402Client: L402Client | undefined): string {
  if (!l402Client) return "";
  const spent = l402Client.totalSpent;
  const remaining = l402Client.remainingBudget;
  if (remaining === Infinity) {
    return spent > 0 ? `\n\n---\nSession spending: ${spent} sats (no budget limit)` : "";
  }
  return `\n\n---\nSession spending: ${spent} sats | Remaining budget: ${remaining} sats`;
}

function formatPricing(ep: {
  pricingModel: string | null;
  priceSats: number | null;
  tokenBudget: number | null;
  durationMinutes: number | null;
  unitCostSats: number | null;
}): string {
  if (!ep.priceSats) return "free";
  switch (ep.pricingModel) {
    case "per_kb":
      return `${ep.unitCostSats ?? ep.priceSats} sats/KB (${ep.priceSats} sats deposit)`;
    case "token_bucket":
      return `${ep.priceSats} sats for ${ep.tokenBudget ?? "N"} requests`;
    case "time_pass":
      return `${ep.priceSats} sats for ${ep.durationMinutes ?? "N"} min`;
    case "metered":
      return `${ep.priceSats} sats deposit, ${ep.unitCostSats ?? "N"} sats/req`;
    default:
      return `${ep.priceSats} sats/request`;
  }
}

function formatEntryCompact(entry: DirectoryEntry): string {
  const lines = [
    `${entry.name} (slug: ${entry.slug})`,
    entry.description ? `  ${entry.description}` : null,
    entry.tags.length > 0 ? `  Tags: ${entry.tags.join(", ")}` : null,
    `  Endpoints: ${entry.endpointCount}`,
  ].filter(Boolean);

  const priceRange = entry.endpoints
    .map((ep) => ep.priceSats)
    .filter((p): p is number => p !== null && p > 0);

  if (priceRange.length > 0) {
    const min = Math.min(...priceRange);
    const max = Math.max(...priceRange);
    lines.push(`  Price: ${min === max ? `${min} sats` : `${min}–${max} sats`}`);
  }

  return lines.join("\n");
}

function formatEntryDetailed(entry: DirectoryEntry, apiClient: ApiClient): string {
  const lines = [
    `# ${entry.name}`,
    "",
    entry.description ?? "",
    "",
    `Slug: ${entry.slug}`,
    `Gateway: ${apiClient.getGatewayUrl(entry.slug)}`,
    entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : "",
    "",
    "## Endpoints",
    "",
  ];

  for (const ep of entry.endpoints) {
    lines.push(`### ${ep.method} ${ep.path}`);
    if (ep.title) lines.push(`Title: ${ep.title}`);
    if (ep.description) lines.push(ep.description);
    lines.push(`Pricing: ${formatPricing(ep)}`);
    if (ep.streaming) {
      lines.push(
        "Streaming (SSE): live event feed. One payment buys one stream connection, not per-event billing. Taste it with call_api + stream_events/stream_seconds, or monitor continuously with open_stream/read_stream/close_stream.",
      );
    }
    if (ep.freeTryEnabled) lines.push("Free try: available");
    if (ep.docsUrl) lines.push(`Docs: ${ep.docsUrl}`);
    if (ep.parameters && ep.parameters.length > 0) {
      lines.push("Parameters:");
      for (const p of ep.parameters) {
        const req = p.required || p.in === "path" ? "required" : "optional";
        const desc = p.description ? ` — ${p.description}` : "";
        const typ = p.type ? ` (${p.type})` : "";
        lines.push(`  - ${p.name} [${p.in}] ${req}${typ}${desc}`);
      }
    }
    if (ep.exampleRequest) {
      lines.push(`Example request: ${JSON.stringify(ep.exampleRequest)}`);
    }
    if (ep.exampleResponse) {
      lines.push(`Example response: ${JSON.stringify(ep.exampleResponse)}`);
    }
    lines.push("");
  }

  lines.push("## Usage");
  lines.push("");
  lines.push(
    'Use the call_api tool to call any endpoint above. Example: call_api({ slug: "' +
      entry.slug +
      '", path: "' +
      (entry.endpoints[0]?.path ?? "/") +
      '", method: "' +
      (entry.endpoints[0]?.method ?? "GET") +
      '" })'
  );

  return lines.filter((l) => l !== undefined).join("\n");
}

/** Handle the `search_apis` MCP tool — search the directory by keyword or tag. */
export async function handleSearchApis(
  args: { query?: string; tag?: string },
  apiClient: ApiClient,
): Promise<ToolResult> {
  try {
    const entries = await apiClient.searchApis(args.query, args.tag);

    if (entries.length === 0) {
      const hint = args.query || args.tag
        ? `No APIs found matching "${args.query ?? args.tag}". Try a broader search or omit filters to see all available APIs.`
        : "The bolthub directory is currently empty.";
      return { content: [{ type: "text", text: hint }] };
    }

    const header = `Found ${entries.length} API${entries.length === 1 ? "" : "s"}${args.query ? ` matching "${args.query}"` : ""}${args.tag ? ` tagged "${args.tag}"` : ""}:\n\n`;
    const listing = entries.map(formatEntryCompact).join("\n\n");
    const footer =
      "\n\nUse get_api_details(slug) to see full endpoint details, or call_api(slug, path, method) to make a request.";

    return { content: [{ type: "text", text: header + listing + footer }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Handle the `get_api_details` MCP tool — fetch full API info by slug. */
export async function handleGetApiDetails(
  args: { slug: string },
  apiClient: ApiClient,
): Promise<ToolResult> {
  try {
    const entry = await apiClient.getApiDetails(args.slug);
    return { content: [{ type: "text", text: formatEntryDetailed(entry, apiClient) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Handle the `preview_cost` MCP tool — show pricing without making a call. */
export async function handlePreviewCost(
  args: { slug: string; path?: string; method?: string },
  apiClient: ApiClient,
  l402Client: L402Client | undefined,
): Promise<ToolResult> {
  try {
    const entry = await apiClient.getApiDetails(args.slug);
    const method = args.method?.toUpperCase();

    const matchingEndpoints = args.path
      ? entry.endpoints.filter(
          (ep) =>
            ep.path === args.path && (!method || ep.method === method),
        )
      : entry.endpoints;

    if (matchingEndpoints.length === 0) {
      const hint = args.path
        ? `No endpoint found at ${method ?? "ANY"} ${args.path} for "${args.slug}".`
        : `No endpoints found for "${args.slug}".`;
      return { content: [{ type: "text", text: hint }] };
    }

    const lines: string[] = [`Cost preview for ${entry.name}:\n`];

    for (const ep of matchingEndpoints) {
      lines.push(`${ep.method} ${ep.path}`);
      lines.push(`  Pricing: ${formatPricing(ep)}`);
      if (ep.freeTryEnabled) lines.push("  Free try: available (one free request for signed-in users)");
      lines.push("");
    }

    if (l402Client) {
      const spent = l402Client.totalSpent;
      const remaining = l402Client.remainingBudget;
      if (remaining !== Infinity) {
        lines.push(`Session budget: ${spent} sats spent, ${remaining} sats remaining`);
      } else if (spent > 0) {
        lines.push(`Session spending so far: ${spent} sats (no budget limit)`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Handle the `call_api` MCP tool — call a gateway endpoint with automatic L402 payment. */
export async function handleCallApi(
  args: {
    slug: string;
    path: string;
    method?: string;
    max_cost_sats?: number;
    body?: Record<string, unknown> | string;
    query_params?: Record<string, string>;
    headers?: Record<string, string>;
    stream_events?: number;
    stream_seconds?: number;
  },
  apiClient: ApiClient,
  l402Client: L402Client | undefined,
): Promise<ToolResult> {
  try {
    const method = (args.method ?? "GET").toUpperCase();
    let url = apiClient.getGatewayUrl(args.slug, args.path);

    if (args.query_params && Object.keys(args.query_params).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args.query_params)) {
        params.set(k, v);
      }
      url = `${url}?${params.toString()}`;
    }

    const fetchOptions: RequestInit = { method };
    const reqHeaders: Record<string, string> = { ...(args.headers ?? {}) };
    const externalAuth = Object.keys(reqHeaders).some((k) => k.toLowerCase() === "authorization");

    if (args.body && method !== "GET" && method !== "HEAD") {
      reqHeaders["Content-Type"] = "application/json";
      fetchOptions.body =
        typeof args.body === "string" ? args.body : JSON.stringify(args.body);
    }

    if (Object.keys(reqHeaders).length > 0) {
      fetchOptions.headers = reqHeaders;
    }

    if (!l402Client) {
      const resp = await fetch(url, fetchOptions);
      // Free streaming endpoint: window-read (a plain fetch here has no
      // timeout, so resp.text() on a live stream would hang forever).
      if (resp.ok && isEventStreamResponse(resp)) {
        const caps = clampStreamCaps(args);
        const window = await readStreamWindow(resp, caps);
        return {
          content: [{ type: "text", text: formatStreamWindow(window, caps, "") }],
          isError: window.reason === "error",
        };
      }
      const text = await resp.text();
      if (resp.status === 402) {
        return {
          content: [{ type: "text", text: `This endpoint requires payment and no wallet is configured.\n${WALLET_ENV_HINT}\n\nHTTP 402: ${text}` }],
          isError: true,
        };
      }
      if (!resp.ok) {
        return { content: [{ type: "text", text: `HTTP ${resp.status}: ${text}` }], isError: true };
      }
      return { content: [{ type: "text", text: prettyJson(text) + paymentOutcomeLine(resp, false, externalAuth) }] };
    }

    // max_cost_sats is a REAL per-call cap (L402Client refuses and pays
    // nothing past it); the per-request onPaid records this call's exact
    // cost — totalSpent deltas are racy under a shared budget.
    const maxCost = args.max_cost_sats && args.max_cost_sats > 0 ? args.max_cost_sats : undefined;
    // stream_* args declare the caller expects a live SSE feed: the SDK
    // then bounds only time-to-headers, never the body read. Without the
    // args a streaming response is still detected by content type below
    // (default window caps well inside the SDK's whole-request timeout).
    const wantsStream = args.stream_events != null || args.stream_seconds != null;
    let callCost = 0;
    const resp = await l402Client
      .request(url, {
        ...fetchOptions,
        maxCostSats: maxCost,
        ...(wantsStream ? { streaming: true } : {}),
        onPaid: (info) => {
          callCost = info.amount;
        },
      })
      .catch((err: unknown) => {
        if (maxCost && err instanceof Error && err.name === "L402BudgetError") {
          throw new Error(`Invoice exceeds max_cost_sats limit of ${maxCost} sats. ${err.message}`);
        }
        throw err;
      });

    const suffix = (callCost > 0
      ? `\n\n---\nCost: ${callCost} sats${budgetSummary(l402Client)}`
      : budgetSummary(l402Client)) + paymentOutcomeLine(resp, callCost > 0, externalAuth);

    // Live SSE body: read a bounded window instead of buffering — a
    // stream never ends, so resp.text() here used to burn the payment
    // and time out (the hub's P0 bug, on the agent surface).
    if (resp.ok && isEventStreamResponse(resp)) {
      const caps = clampStreamCaps(args);
      const window = await readStreamWindow(resp, caps);
      const costLine = callCost > 0 ? ` · cost: ${callCost} sats` : "";
      return {
        content: [{ type: "text", text: formatStreamWindow(window, caps, costLine) + suffix }],
        isError: window.reason === "error",
      };
    }

    const text = await resp.text();

    if (!resp.ok) {
      return {
        content: [{ type: "text", text: `HTTP ${resp.status}: ${text}${suffix}` }],
        isError: true,
      };
    }

    const streamNote = wantsStream
      ? "\n[note: stream_events/stream_seconds were passed but the endpoint returned a complete (non-stream) response]"
      : "";
    return { content: [{ type: "text", text: prettyJson(text) + streamNote + suffix }] };
  } catch (err) {
    const suffix = budgetSummary(l402Client);
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}${suffix}` }],
      isError: true,
    };
  }
}

/**
 * Handle the `buy_credit` MCP tool — pay once for prepaid credit spendable
 * across ALL of a provider's endpoints (cross-endpoint prepaid credit). After
 * this, call_api to any of that provider's endpoints draws the credit with no
 * new payment. Credit is face-value (the server charges exactly the requested
 * amount) and per-provider: buying credit for one provider never covers another
 * (that would require a pooled/custodial balance, which bolthub never holds).
 */
export async function handleBuyCredit(
  args: { slug: string; path: string; credit_sats: number; max_cost_sats?: number },
  apiClient: ApiClient,
  l402Client: L402Client | undefined,
): Promise<ToolResult> {
  if (!l402Client) {
    return {
      content: [{ type: "text", text: `Buying credit requires a wallet.\n${WALLET_ENV_HINT}` }],
      isError: true,
    };
  }
  try {
    const url = apiClient.getGatewayUrl(args.slug, args.path);
    const maxCost = args.max_cost_sats && args.max_cost_sats > 0 ? args.max_cost_sats : undefined;
    let cost = 0;
    const result = await l402Client.buyCredit(url, args.credit_sats, {
      maxCostSats: maxCost,
      onPaid: (info) => {
        cost = info.amount;
      },
    });
    return {
      content: [
        {
          type: "text",
          text:
            `Bought ${result.creditSats} sats of prepaid credit for ${args.slug}. Cost: ${cost} sats.${budgetSummary(l402Client)}\n` +
            `call_api requests to ANY of ${args.slug}'s endpoints now draw this credit (no new payment) until it runs out.`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error buying credit: ${err instanceof Error ? err.message : String(err)}${budgetSummary(l402Client)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Handle the `mint_scoped_token` MCP tool — attenuate the prepaid-credit
 * credential the session already holds for this provider into a tighter child,
 * offline, so a sub-agent can be handed a scoped, capped credential without
 * re-paying or ever seeing the parent's wallet (AF-D5). The child is just a
 * macaroon: the worker spends it with a plain L402 client / `call_api`, and the
 * gateway enforces every cap. Attenuation is tighten-only, so the child can
 * never widen scope. Credit is tenant-scoped, so a credit credential bought for
 * the provider is delegable for any of its endpoints — `buy_credit` first.
 */
export async function handleMintScopedToken(
  args: {
    slug: string;
    path: string;
    spend_cap_sats?: number;
    n_uses?: number;
    expiry?: string | number;
    path_prefix?: string;
  },
  apiClient: ApiClient,
  l402Client: L402Client | undefined,
): Promise<ToolResult> {
  if (!l402Client) {
    return {
      content: [{ type: "text", text: `Minting a scoped token requires a wallet.\n${WALLET_ENV_HINT}` }],
      isError: true,
    };
  }
  const url = apiClient.getGatewayUrl(args.slug, args.path);
  const cred = l402Client.getCreditCredential(url);
  if (!cred) {
    return {
      content: [
        {
          type: "text",
          text:
            `No delegable credential is held for ${args.slug}. Delegation attenuates a ` +
            `prepaid-credit credential you already hold for the provider: buy_credit for ${args.slug} first, ` +
            `then mint a scoped child from it. ` +
            `(A single-use per_request payment is spent in the same call, so there is nothing cached to hand on.)`,
        },
      ],
      isError: true,
    };
  }

  const opts: AttenuateOptions = {};
  if (args.n_uses != null) opts.nUses = args.n_uses;
  if (args.spend_cap_sats != null) opts.maxSats = args.spend_cap_sats;
  if (args.path_prefix != null) opts.pathPrefix = args.path_prefix;
  let expiryMs: number | undefined;
  if (args.expiry != null) {
    expiryMs = typeof args.expiry === "number" ? args.expiry : Date.parse(args.expiry);
    if (!Number.isFinite(expiryMs)) {
      return {
        content: [{ type: "text", text: `Invalid expiry ${JSON.stringify(args.expiry)}: pass an ISO 8601 timestamp or Unix milliseconds.` }],
        isError: true,
      };
    }
    opts.validUntil = expiryMs;
  }

  let child: string;
  try {
    child = attenuate(cred.macaroon, opts); // throws if no restriction, or if it would widen scope
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error minting scoped token: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  // AF-D6 budget interlock: hold the child's sat cap against the parent budget
  // now, so parent + children can never jointly overspend the parent's intent
  // (SPIKE-6 reserve semantics). Boundary: cap == remaining accepted,
  // remaining + 1 refused. Attenuate first (pure) so a refusal mints nothing.
  if (args.spend_cap_sats != null) {
    try {
      l402Client.reserveDelegatedCap(args.spend_cap_sats);
    } catch {
      return {
        content: [
          {
            type: "text",
            text:
              `Child spend cap ${args.spend_cap_sats} sats exceeds your remaining budget ` +
              `(${l402Client.remainingBudget} sats). Lower the cap or free budget first — no token was minted.`,
          },
        ],
        isError: true,
      };
    }
  }

  auditMint({
    resource: `${args.slug}${args.path}`,
    nUses: args.n_uses,
    maxSats: args.spend_cap_sats,
    pathPrefix: args.path_prefix,
    expiryMs,
  });

  const childCredential = `L402 ${child}:${cred.preimage}`;
  const reservedNote =
    args.spend_cap_sats != null
      ? ` Reserved ${args.spend_cap_sats} sats from your budget (${l402Client.remainingBudget} remaining); revoke_token returns it.`
      : "";
  return {
    content: [
      {
        type: "text",
        text:
          `Minted a scoped child credential for ${args.slug}${args.path}.\n` +
          `Scope: ${scopeSummary(opts, expiryMs)}.${reservedNote}\n\n` +
          `Hand this to the sub-agent as its Authorization header (it works with a plain L402 client or call_api):\n` +
          `${childCredential}\n\n` +
          `The gateway enforces every cap and the child cannot widen this scope. Revoke the whole delegation tree with revoke_token.`,
      },
    ],
  };
}

/**
 * Handle the `revoke_token` MCP tool — revoke the grant behind a bundle the
 * session holds, killing the whole delegation tree minted from it (AF-D8). The
 * gateway is authed by the credential's own preimage (payment_hash =
 * sha256(preimage)); on success the local credential is dropped so we stop
 * presenting a dead token, and any child-cap budget the caller names is
 * returned to the parent budget.
 */
export async function handleRevokeToken(
  args: { slug: string; path: string; released_sats?: number },
  apiClient: ApiClient,
  l402Client: L402Client | undefined,
): Promise<ToolResult> {
  if (!l402Client) {
    return {
      content: [{ type: "text", text: `Revoking a token requires a wallet.\n${WALLET_ENV_HINT}` }],
      isError: true,
    };
  }
  const endpointUrl = apiClient.getGatewayUrl(args.slug, args.path);
  const cred = l402Client.getCreditCredential(endpointUrl);
  if (!cred) {
    return {
      content: [
        {
          type: "text",
          text:
            `No credential is held for ${args.slug}, so there is nothing to revoke here. ` +
            `revoke_token kills the grant behind the prepaid credit this session bought (and every child minted from it).`,
        },
      ],
      isError: true,
    };
  }

  const revokeUrl = apiClient.getGatewayUrl(args.slug, "/.well-known/l402/revoke");
  try {
    const resp = await fetch(revokeUrl, {
      method: "POST",
      headers: { Authorization: `L402 ${cred.macaroon}:${cred.preimage}` },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return {
        content: [{ type: "text", text: `Revoke failed (HTTP ${resp.status})${detail ? `: ${detail}` : ""}.` }],
        isError: true,
      };
    }
    // The gateway's revoke is idempotent: HTTP 200 with revoked=false means
    // NO active grant matched this credential (already terminal, or never
    // server-backed at all). Reporting that as a successful revoke would
    // leave the caller believing a live credential was killed when nothing
    // changed — say exactly what happened instead.
    let revokedFlag: boolean | undefined;
    try {
      revokedFlag = ((await resp.clone().json()) as { revoked?: boolean })?.revoked;
    } catch {
      /* non-JSON body: fall through as unknown */
    }
    if (revokedFlag === false) {
      l402Client.dropCreditCredential(endpointUrl);
      // Still return any named child-cap reservation: the budget must not
      // stay locked behind a credential that has no live grant.
      let releasedNote = "";
      if (args.released_sats && args.released_sats > 0) {
        l402Client.rollbackDelegatedCap(args.released_sats);
        releasedNote = ` Returned ${args.released_sats} sats of reserved child budget (${l402Client.remainingBudget} remaining).`;
      }
      return {
        content: [
          {
            type: "text",
            text:
              `No active grant matched this credential for ${args.slug}${args.path} — nothing was revoked. ` +
              `Either it was already revoked/expired, or the credential was never backed by a server-side grant. ` +
              `The local credential has been dropped either way.${releasedNote}`,
          },
        ],
        isError: true,
      };
    }
    // Stop presenting the now-dead credential locally, and return any child-cap
    // budget the caller reserved for descendants of this grant.
    l402Client.dropCreditCredential(endpointUrl);
    let released = "";
    if (args.released_sats && args.released_sats > 0) {
      l402Client.rollbackDelegatedCap(args.released_sats);
      released = ` Returned ${args.released_sats} sats of reserved child budget (${l402Client.remainingBudget} remaining).`;
    }
    auditRevoke({ resource: `${args.slug}${args.path}`, releasedSats: args.released_sats });
    return {
      content: [
        {
          type: "text",
          text:
            `Revoked the grant for ${args.slug}${args.path}. The parent credential and every child minted from it ` +
            `fail on their next request (token_revoked) within ~15s.${released}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error revoking token: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Human-readable one-line summary of a child's scope for the mint result. */
function scopeSummary(opts: AttenuateOptions, expiryMs?: number): string {
  const parts: string[] = [];
  if (opts.nUses != null) parts.push(`${opts.nUses} use${opts.nUses === 1 ? "" : "s"}`);
  if (opts.maxSats != null) parts.push(`≤ ${opts.maxSats} sats total`);
  if (opts.pathPrefix != null) parts.push(`paths under ${opts.pathPrefix}`);
  if (opts.method != null) parts.push(`method ${opts.method}`);
  if (expiryMs != null) parts.push(`expires ${new Date(expiryMs).toISOString()}`);
  return parts.length ? parts.join(", ") : "(no restriction)";
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * One line telling the agent what happened to this call's money, from the
 * gateway's X-Bolthub-Payment taxonomy (AF-R5). L402Client already retried
 * free-retryable failures transparently, so a surviving `reverted` /
 * `refunded_to_balance` means the origin kept failing — the key fact for a
 * retry loop is that re-sending costs nothing. Empty when the gateway
 * didn't emit the headers (flag off / older gateway).
 *
 * paidThisCall distinguishes the ways a call can be server-"charged":
 * a fresh Lightning payment (the client's wallet paid this call) vs a
 * prepaid credential drawing down (bundle use burned — no new payment).
 * The gateway can't tell the client's wallet activity, so the client-side
 * fact wins the wording. externalAuth marks the third way (L1): the caller
 * supplied its own Authorization header (a delegated child token, or a
 * credential minted elsewhere), so nothing of THIS session's budget or
 * prepaid credit was touched — "prepaid use burned" would misreport that.
 */
function paymentOutcomeLine(resp: Response, paidThisCall: boolean, externalAuth = false): string {
  const status = readPaymentStatus(resp.headers);
  if (!status) return "";
  switch (status.state) {
    case "charged": {
      const how = paidThisCall
        ? "charged"
        : externalAuth
          ? "external credential accepted (no new payment; this session's budget and prepaid credit are untouched)"
          : "prepaid use burned (no new payment)";
      return resp.ok
        ? `\nPayment: ${how}`
        : `\nPayment: ${how} (4xx answers are real responses and stay paid)`;
    }
    case "reverted":
      return "\nPayment: reverted — NOT lost; re-sending this exact call is free (no new payment)";
    case "refunded_to_balance":
      return "\nPayment: refunded to session balance — re-sending this call is free";
    case "not_charged":
      return "\nPayment: not charged";
    default:
      return `\nPayment: ${status.state}${status.code ? ` (${status.code})` : ""}`;
  }
}

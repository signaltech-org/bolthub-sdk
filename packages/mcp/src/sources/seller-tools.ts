/**
 * Seller onboarding tools (GR-T3; design in docs/design/growth/DESIGN-AGENT-TOOLS.md):
 *
 * - `list_api` — conversational listing: spec in → DRAFT paywalled listing out.
 *   Drafts are created with `directoryListed: false` explicitly and are never
 *   visible in the directory; the agent does the assembly, not the deciding.
 * - `publish_listing` — the explicit go-live step. Without `confirm: true` it
 *   only echoes exactly what would go live.
 *
 * Auth reuses the deploy_node mechanism unchanged: the caller passes the
 * BOLTHUB_ACCOUNT_TOKEN owner JWT, sent as a Bearer token to authMiddleware
 * routes. The token is never logged and never appears in tool output.
 */

import {
  parseFile,
  deduplicateEndpoints,
  getGatewayUrl,
  type ImportedEndpoint,
} from "@bolthub/shared";
import { apiRequest, isWalletRequiredError } from "./node-tools.js";
import { readStoredToken } from "./connect-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_API_URL = "https://api.bolthub.ai";

/**
 * The paid-publish gate (WALLET_REQUIRED) can't be fixed from chat with a
 * secret, so turn it into the two chat-native next steps instead of echoing a
 * raw failure: bind/connect a wallet, or deploy a node to bind.
 */
const WALLET_REQUIRED_GUIDANCE = [
  "Can't publish a paid endpoint yet — this workspace has no connected wallet, so buyers couldn't be charged.",
  "Fix it, then re-run publish_listing:",
  "- connect_wallet — bind a deployed node (node_id) or get the browser link for NWC/LND.",
  "- deploy_node — no node yet? Spin up your own LND node in ~5 minutes, then bind it.",
  "Drafts stay safe in the meantime; nothing was published.",
].join("\n");

// D5 pricing rails. The soft cap bounds what we PROPOSE; a seller can state
// a higher number themselves (restate-to-exceed) — but never via a value
// smuggled in from a spec, since pricing is never read from spec content.
export const DEFAULT_PRICE_SATS = 5;
export const PRICE_FLOOR_SATS = 1;
export const PRICE_SOFT_CAP_SATS = 1000;
// Hostile-spec guard: one import writes at most this many endpoints.
export const IMPORT_CAP = 100;

// Mirror of the API's write-path limits (routes/endpoints.ts): descriptions
// shorter than the floor are dropped (the route would 400 the whole row),
// longer fields are truncated rather than rejected.
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 1000;
const TITLE_MAX = 255;
const DOCS_URL_PATTERN = /^https?:\/\/[^\s"'<>]+$/;

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  directoryListed: boolean;
  trialEndsAt?: string | null;
  /** Wallet-health verdict (wallet-health job); null/absent = never checked. */
  walletReachable?: boolean | null;
  walletConnected?: boolean;
  /** "node_launcher" = payout wallet is a bolthub-managed node (mint-only macaroon). */
  walletConnectionMethod?: string | null;
}

interface EndpointRow {
  id: string;
  path: string;
  method: string;
  title: string | null;
  isActive: boolean;
  directoryListed: boolean;
  pricingRules?: Array<{ pricingModel: string; priceSats: number }>;
}

/**
 * The account token gates every tool that acts ON the user's bolthub
 * account (seller tools + Node Launcher); buyer-side tools are account-less
 * by design and never read it. Resolution order: env BOLTHUB_ACCOUNT_TOKEN,
 * legacy BOLTHUB_AUTH_TOKEN (0.4.x configs, silent fallback), then the
 * credentials file written by the connect_account pairing flow.
 */
export function resolveAccountToken(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.BOLTHUB_ACCOUNT_TOKEN ?? env.BOLTHUB_AUTH_TOKEN ?? readStoredToken();
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function requireAuth(authToken: string | undefined): ToolResult | null {
  if (authToken) return null;
  return errorResult(
    [
      "This tool needs your bolthub account token.",
      "Easiest: run connect_account for one-click browser pairing.",
      "Or set BOLTHUB_ACCOUNT_TOKEN in the MCP server config (dashboard → Settings → MCP setup).",
      "Without it the tool cannot act on your workspace.",
    ].join("\n"),
  );
}

/**
 * Resolve which workspace to act on. `tenant_id` wins; a single-workspace
 * account needs no id; multiple workspaces get listed so the user can pick.
 * Creating a workspace stays a dashboard step (design non-goal).
 */
export async function resolveTenant(
  baseUrl: string,
  authToken: string,
  tenantId?: string,
): Promise<{ tenant: TenantRow } | { error: ToolResult }> {
  const { tenants } = await apiRequest<{ tenants: TenantRow[] }>(baseUrl, "/tenants", {
    token: authToken,
  });
  if (tenantId) {
    const tenant = tenants.find((t) => t.id === tenantId);
    if (!tenant) {
      return { error: errorResult(`No workspace with id ${tenantId} on this account.`) };
    }
    return { tenant };
  }
  if (tenants.length === 1) return { tenant: tenants[0] };
  if (tenants.length === 0) {
    return {
      error: errorResult(
        "This account has no workspace yet. Run create_workspace to make one (free while empty), or create it in the dashboard, then re-run this tool.",
      ),
    };
  }
  return {
    error: textResult(
      [
        "This account has several workspaces — re-run with tenant_id set to one of:",
        ...tenants.map((t) => `  ${t.id}  ${t.name} (${t.slug})`),
      ].join("\n"),
    ),
  };
}

/** Per-endpoint pricing-model suggestion (D5) — a note, never auto-applied. */
export function pricingSuggestion(ep: ImportedEndpoint): string | undefined {
  const haystack = `${ep.path} ${ep.title ?? ""}`;
  if (ep.exampleResponse && JSON.stringify(ep.exampleResponse).length > 4096) {
    return "consider per_kb — sample response is large, per-request would underprice fat payloads";
  }
  if (/(generate|render|analy[sz]e|compute|transform|convert|summari[sz]e)/i.test(haystack)) {
    return "consider metered — looks compute-shaped, price by units of work";
  }
  if (/(stream|feed|realtime|live|subscribe)/i.test(haystack)) {
    return "consider time_pass — time-window semantics fit a pass better than per-call";
  }
  return undefined;
}

interface SanitizedRow {
  path: string;
  method: string;
  originUrl?: string;
  title?: string;
  description?: string;
  docsUrl?: string;
  exampleRequest?: Record<string, unknown>;
  exampleResponse?: Record<string, unknown>;
  parameters?: ImportedEndpoint["parameters"];
  directoryListed: false;
}

/**
 * Clamp parsed rows to the API's write-path limits so a hostile or sloppy
 * spec can't 400 the import or smuggle oversized fields. Parameters are
 * forwarded as data (the API stores them as jsonb; nothing is executed).
 */
export function sanitizeRow(ep: ImportedEndpoint, originUrl?: string): SanitizedRow {
  const description =
    ep.description && ep.description.length >= DESCRIPTION_MIN
      ? ep.description.slice(0, DESCRIPTION_MAX)
      : undefined;
  const docsUrl =
    ep.docsUrl && DOCS_URL_PATTERN.test(ep.docsUrl) && ep.docsUrl.length <= 2048
      ? ep.docsUrl
      : undefined;
  return {
    path: ep.path,
    method: ep.method,
    originUrl: originUrl ?? ep.originUrl,
    title: ep.title ? ep.title.slice(0, TITLE_MAX) : undefined,
    description,
    docsUrl,
    exampleRequest: ep.exampleRequest,
    exampleResponse: ep.exampleResponse,
    parameters: ep.parameters,
    directoryListed: false,
  };
}

export async function handleListApi(
  args: {
    tenant_id?: string;
    spec_url?: string;
    spec_content?: string;
    origin_url?: string;
    price_sats?: number;
    apply_sync?: boolean;
  },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  const authError = requireAuth(authToken);
  if (authError) return authError;

  if (!args.spec_url && !args.spec_content) {
    return errorResult(
      [
        "Provide a spec to import: spec_url (OpenAPI/Swagger or Postman, JSON or YAML) or spec_content (the same, inline).",
        'For manual assembly without a spec, pass spec_content as a plain JSON array of rows like [{"method":"GET","path":"/v1/thing","title":"...","description":"..."}].',
      ].join("\n"),
    );
  }
  if (args.spec_url && args.spec_content) {
    return errorResult("Provide either spec_url or spec_content, not both.");
  }
  const priceSats = args.price_sats ?? DEFAULT_PRICE_SATS;
  if (priceSats < PRICE_FLOOR_SATS || !Number.isFinite(priceSats)) {
    return errorResult(`price_sats must be at least ${PRICE_FLOOR_SATS} sat.`);
  }

  try {
    const resolved = await resolveTenant(baseUrl, authToken!, args.tenant_id);
    if ("error" in resolved) return resolved.error;
    const tenant = resolved.tenant;

    // Spec text. URLs go through the API's SSRF-safe fetch proxy (size cap,
    // content-type checks, blocked private ranges) — never fetched directly
    // from the MCP process.
    let specText: string;
    let fileName: string;
    if (args.spec_url) {
      const fetched = await apiRequest<{ body: string; fileName: string }>(
        baseUrl,
        "/spec-import/fetch",
        { method: "POST", body: { url: args.spec_url }, token: authToken },
      );
      specText = fetched.body;
      fileName = fetched.fileName || "spec.yaml";
    } else {
      specText = args.spec_content!;
      // parseFile tries JSON first regardless of name; a .yaml hint keeps
      // the YAML fallback available for inline pastes.
      fileName = "inline.yaml";
    }

    const parsedSpec = parseFile(specText, fileName);
    if (!parsedSpec) {
      return errorResult(
        "Could not parse that as OpenAPI/Swagger, a Postman collection, or a JSON endpoint array. Check the spec, or import via the dashboard (Endpoints → Import).",
      );
    }
    const { endpoints: deduped, mergedCount } = deduplicateEndpoints(parsedSpec.endpoints);

    const truncated = Math.max(0, deduped.length - IMPORT_CAP);
    const capped = deduped.slice(0, IMPORT_CAP);
    const rows = capped.map((ep) => sanitizeRow(ep, args.origin_url));

    const withOrigin = rows.filter((r) => r.originUrl);
    const missingOrigin = rows.length - withOrigin.length;
    if (withOrigin.length === 0) {
      return errorResult(
        [
          `Parsed ${rows.length} endpoint(s) (${parsedSpec.format}), but the spec declares no base URL.`,
          "Re-run with origin_url set to the upstream API's base URL (e.g. https://api.example.com).",
        ].join("\n"),
      );
    }

    // Re-import? If the target origin already exists with endpoints, route
    // through the sync flow (dry-run diff first) instead of duplicating rows.
    // Sync only ever writes spec-owned fields; pricing stays operator-owned.
    const originUrlNorm = withOrigin[0].originUrl!.replace(/\/+$/, "");
    const { origins } = await apiRequest<{
      origins: Array<{ id: string; baseUrl: string; endpoints?: Array<{ id: string }> }>;
    }>(baseUrl, `/tenants/${tenant.id}/origins`, { token: authToken });
    const existing = origins.find((o) => o.baseUrl.replace(/\/+$/, "") === originUrlNorm);

    if (existing && (existing.endpoints?.length ?? 0) > 0) {
      const syncRows = withOrigin.map(({ originUrl: _o, directoryListed: _d, ...spec }) => spec);
      if (!args.apply_sync) {
        const { diff } = await apiRequest<{ diff: unknown }>(
          baseUrl,
          `/tenants/${tenant.id}/endpoints/sync`,
          {
            method: "POST",
            body: { originId: existing.id, dryRun: true, endpoints: syncRows },
            token: authToken,
          },
        );
        return textResult(
          [
            `Origin ${originUrlNorm} already has a listing — this is a re-import, so nothing was changed.`,
            "Dry-run diff (spec-owned fields only; pricing and gateway settings are never touched by sync):",
            JSON.stringify(diff, null, 2),
            "",
            "To apply this diff, re-run list_api with apply_sync: true, or review it in the dashboard sync screen.",
          ].join("\n"),
        );
      }
      const { result } = await apiRequest<{ result: unknown }>(
        baseUrl,
        `/tenants/${tenant.id}/endpoints/sync`,
        {
          method: "POST",
          body: { originId: existing.id, endpoints: syncRows },
          token: authToken,
        },
      );
      return textResult(
        [
          `Sync applied to ${originUrlNorm}:`,
          JSON.stringify(result, null, 2),
          "",
          "Pricing was not changed (sync never touches it).",
        ].join("\n"),
      );
    }

    // First import: create every row as an UNLISTED draft, then apply the
    // proposed default pricing. Nothing becomes visible in the directory.
    const created = await apiRequest<{
      endpoints: Array<{ id: string; path: string; method: string; title: string | null }>;
      skipped: Array<{ index: number; path: string; reason: string }>;
    }>(baseUrl, `/tenants/${tenant.id}/endpoints/bulk`, {
      method: "POST",
      body: { endpoints: withOrigin },
      token: authToken,
    });

    if (created.endpoints.length > 0) {
      await apiRequest(baseUrl, `/tenants/${tenant.id}/endpoints/bulk-pricing`, {
        method: "PUT",
        body: {
          endpointIds: created.endpoints.map((e) => e.id),
          pricing: { pricingModel: "per_request", priceSats },
        },
        token: authToken,
      });
    }

    const suggestionByKey = new Map<string, string | undefined>(
      capped.map((ep) => [`${ep.method} ${ep.path}`, pricingSuggestion(ep)]),
    );
    const lines: string[] = [
      `Draft listing created in workspace "${tenant.name}" — ${created.endpoints.length} endpoint(s), all UNLISTED (directoryListed: false). Nothing is public yet.`,
      "",
      ...created.endpoints.map((e) => {
        const suggestion = suggestionByKey.get(`${e.method} ${e.path}`);
        const base = `  ${e.method} ${e.path}${e.title ? ` — ${e.title}` : ""} · ${priceSats} sats/request`;
        return suggestion ? `${base} · ${suggestion}` : base;
      }),
    ];
    if (created.skipped.length > 0) {
      lines.push("", `Skipped ${created.skipped.length} row(s):`);
      lines.push(...created.skipped.map((s) => `  ${s.path} — ${s.reason}`));
    }
    if (missingOrigin > 0) {
      lines.push("", `${missingOrigin} row(s) had no base URL and were not imported (pass origin_url to include them).`);
    }
    if (truncated > 0) {
      lines.push("", `Import capped at ${IMPORT_CAP} endpoints — ${truncated} further row(s) in the spec were NOT imported.`);
    }
    if (mergedCount > 0) {
      lines.push("", `${mergedCount} duplicate row(s) in the spec were merged.`);
    }
    const preview = created.endpoints[0];
    if (preview) {
      lines.push(
        "",
        `Gateway URL preview (live after publishing): ${getGatewayUrl(tenant.slug, preview.path)}`,
      );
    }
    lines.push(
      "",
      "Next: review pricing and descriptions (dashboard → Endpoints), then run publish_listing to go live — or ask me to run analyze_listing first.",
    );
    return textResult(lines.join("\n"));
  } catch (err) {
    if (isWalletRequiredError(err)) return errorResult(WALLET_REQUIRED_GUIDANCE);
    return errorResult(`list_api failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handlePublishListing(
  args: { tenant_id?: string; endpoint_ids?: string[]; confirm?: boolean },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  const authError = requireAuth(authToken);
  if (authError) return authError;

  try {
    const resolved = await resolveTenant(baseUrl, authToken!, args.tenant_id);
    if ("error" in resolved) return resolved.error;
    const tenant = resolved.tenant;

    const { endpoints } = await apiRequest<{ endpoints: EndpointRow[] }>(
      baseUrl,
      `/tenants/${tenant.id}/endpoints`,
      { token: authToken },
    );

    let targets: EndpointRow[];
    if (args.endpoint_ids && args.endpoint_ids.length > 0) {
      const byId = new Map(endpoints.map((e) => [e.id, e]));
      const unknown = args.endpoint_ids.filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        return errorResult(`Unknown endpoint id(s) in this workspace: ${unknown.join(", ")}`);
      }
      targets = args.endpoint_ids
        .map((id) => byId.get(id)!)
        .filter((e) => !e.directoryListed);
    } else {
      targets = endpoints.filter((e) => !e.directoryListed);
    }

    const needsActivation = tenant.status === "onboarding";
    const needsTenantListing = !tenant.directoryListed;

    if (targets.length === 0 && !needsActivation && !needsTenantListing) {
      return textResult("Nothing to publish — the workspace is active and every endpoint is already listed.");
    }

    const priceLabel = (e: EndpointRow): string => {
      const rule = e.pricingRules?.[0];
      return rule ? `${rule.priceSats} sats (${rule.pricingModel})` : "NO PRICING RULE";
    };
    const unpriced = targets.filter((e) => !e.pricingRules?.length);
    const inactive = targets.filter((e) => !e.isActive);

    const summary: string[] = [`Publishing plan for workspace "${tenant.name}":`, ""];
    if (targets.length > 0) {
      summary.push(`${targets.length} endpoint(s) become visible in the directory:`);
      summary.push(
        ...targets.map((e) => `  ${e.method} ${e.path}${e.title ? ` — ${e.title}` : ""} · ${priceLabel(e)}`),
      );
    }
    if (needsActivation) {
      summary.push("", "The workspace is still in onboarding — it will be ACTIVATED.");
    }
    if (needsTenantListing) {
      summary.push("", "The workspace itself is unlisted — it will be set directoryListed: true.");
    }
    if (tenant.trialEndsAt == null) {
      summary.push("", "Note: publishing the first endpoint starts the workspace's 30-day free trial.");
    }
    if (tenant.walletConnected === false) {
      summary.push(
        "",
        "WARNING: no payout wallet is connected — the listing would be public but every buyer payment fails at invoice creation. Run connect_wallet first.",
      );
    } else if (tenant.walletConnectionMethod === "node_launcher") {
      // Node-backed wallet: reachable is not payable (H1). One extra GET
      // /nodes only on this path; capacity comes from the monitoring sweep.
      try {
        const { nodes } = await apiRequest<{
          nodes: Array<{
            id: string;
            tenantId: string | null;
            activeChannelCount?: number | null;
            receivingCapacitySat?: number | null;
          }>;
        }>(baseUrl, "/nodes", { token: authToken });
        const bound = nodes.find((n) => n.tenantId === tenant.id);
        if (bound && (bound.activeChannelCount === 0 || bound.receivingCapacitySat === 0)) {
          summary.push(
            "",
            `WARNING: the payout wallet is node ${bound.id}, which ${bound.activeChannelCount === 0 ? "has NO CHANNELS" : "has NO INBOUND CAPACITY"} — the listing would be public but no buyer payment can settle. Get an inbound channel first (node_status has the steps).`,
          );
        }
      } catch {
        // Advisory only — a nodes-list hiccup must not block a publish plan.
      }
    }
    if (unpriced.length > 0) {
      summary.push("", `WARNING: ${unpriced.length} endpoint(s) have no pricing rule — set pricing before publishing them.`);
    }
    if (inactive.length > 0) {
      summary.push("", `Note: ${inactive.length} endpoint(s) are disabled (isActive: false) and will stay unavailable until re-enabled, even once listed.`);
    }

    if (args.confirm !== true) {
      summary.push("", "DRY RUN — nothing was changed. Re-run with confirm: true to publish exactly the above.");
      return textResult(summary.join("\n"));
    }

    const changed: string[] = [];
    if (targets.length > 0) {
      await apiRequest(baseUrl, `/tenants/${tenant.id}/endpoints/bulk`, {
        method: "PATCH",
        body: {
          endpointIds: targets.map((e) => e.id),
          settings: { directoryListed: true },
        },
        token: authToken,
      });
      changed.push(`Listed ${targets.length} endpoint(s).`);
    }
    if (needsActivation) {
      try {
        await apiRequest(baseUrl, `/tenants/${tenant.id}/activate`, {
          method: "POST",
          token: authToken,
        });
        changed.push("Workspace activated.");
      } catch (err) {
        // A parallel session may have activated it between our read and now;
        // that's the end state we wanted.
        const message = err instanceof Error ? err.message : String(err);
        if (!/already activated/i.test(message)) throw err;
        changed.push("Workspace was already activated.");
      }
    }
    if (needsTenantListing) {
      await apiRequest(baseUrl, `/tenants/${tenant.id}`, {
        method: "PATCH",
        body: { directoryListed: true },
        token: authToken,
      });
      changed.push("Workspace listed in the directory.");
    }

    return textResult(
      [
        "Published.",
        ...changed.map((c) => `  - ${c}`),
        "",
        `Directory page: https://bolthub.ai/hub/${tenant.slug}`,
        `Gateway base: ${getGatewayUrl(tenant.slug, "/")}`,
        "Directory search may lag up to ~a minute behind (CDN cache) — the listing itself is live immediately.",
      ].join("\n"),
    );
  } catch (err) {
    if (isWalletRequiredError(err)) return errorResult(WALLET_REQUIRED_GUIDANCE);
    return errorResult(
      `publish_listing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

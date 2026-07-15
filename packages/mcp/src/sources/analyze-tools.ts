/**
 * analyze_listing (GR-T4; design in docs/design/growth/DESIGN-AGENT-TOOLS.md):
 * audit a listing against the seller-guide rubric and return a prioritized
 * punch list. Read-only — every finding carries evidence and a fix pointer,
 * and nothing is ever changed. The origin-protection check actively probes
 * the origin (via the owner API's check route) but mutates no state.
 */

import { apiRequest } from "./node-tools.js";
import { requireAuth, resolveTenant, errorResult, textResult, pricingSuggestion } from "./seller-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_API_URL = "https://api.bolthub.ai";

// Per-endpoint health/usage detail costs two API calls per row; cap the
// detailed sweep so a 500-endpoint listing doesn't fan out unboundedly.
// Structural checks (descriptions, examples, pricing fit) still cover
// every endpoint.
export const DETAIL_CAP = 25;
// Distinct origins actively probed per audit.
const ORIGIN_CHECK_CAP = 5;
// Rubric thresholds, from the seller guide: uptime floor, "sane" p95
// (a third of the gateway's 30s proxy timeout), and the hard-failure
// share that flips honest-status-codes to HIGH.
const UPTIME_FLOOR_PCT = 99;
const P95_CEILING_MS = 10_000;
const HARD_FAIL_SHARE = 0.05;
const MIN_TRAFFIC_FOR_ERROR_CHECK = 20;

type Severity = "HIGH" | "MED" | "LOW";

interface Finding {
  severity: Severity;
  text: string;
}

interface AuditEndpointRow {
  id: string;
  path: string;
  method: string;
  title: string | null;
  description: string | null;
  parameters: unknown[] | null;
  exampleRequest: Record<string, unknown> | null;
  exampleResponse: Record<string, unknown> | null;
  latestSampleId: string | null;
  freeTryEnabled: boolean;
  isActive: boolean;
  directoryListed: boolean;
  originId: string | null;
  origin?: { id: string; baseUrl: string } | null;
  pricingRules?: Array<{ pricingModel: string; priceSats: number }>;
}

interface HealthResponse {
  isHealthy: boolean;
  uptimePercentage: number | null;
  avgResponseTimeMs: number | null;
}

interface LogsSummary {
  totalRequests: number;
  successRate: number;
  p95LatencyMs: number;
  errorBreakdown: { timeout: number; connectionError: number; origin5xx: number; origin4xx: number };
}

interface OriginCheck {
  verdict: "protected" | "public" | "broken" | "unreachable" | "inconclusive";
  signed: { statusCode?: number };
  unsigned: { statusCode?: number };
}

const label = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/** "GET /a, GET /b + 3 more" — keeps aggregate findings readable. */
function nameList(rows: Array<{ method: string; path: string }>, max = 5): string {
  const names = rows.slice(0, max).map(label).join(", ");
  return rows.length > max ? `${names} + ${rows.length - max} more` : names;
}

export async function handleAnalyzeListing(
  args: { tenant_id?: string; endpoint_id?: string },
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

    const { endpoints } = await apiRequest<{ endpoints: AuditEndpointRow[] }>(
      baseUrl,
      `/tenants/${tenant.id}/endpoints`,
      { token: authToken },
    );

    let rows = endpoints;
    if (args.endpoint_id) {
      rows = endpoints.filter((e) => e.id === args.endpoint_id);
      if (rows.length === 0) {
        return errorResult(`No endpoint with id ${args.endpoint_id} in this workspace.`);
      }
    }
    if (rows.length === 0) {
      return textResult("This workspace has no endpoints yet — run list_api with a spec to create a draft listing.");
    }

    const findings: Finding[] = [];
    const notes: string[] = [
      "402-challenge rate (quotes that never convert) isn't surfaced by the API yet — not auditable in v1.",
    ];

    // Payout wallet dark = every check below is moot: nothing can be sold.
    if (tenant.walletReachable === false) {
      findings.push({
        severity: "HIGH",
        text: `[wallet] The payout wallet is UNREACHABLE (wallet-health checks failing) — every buyer payment fails at invoice creation, regardless of listing quality. Fix: payouts page; if it's a phone-wallet NWC connection, switch to an always-on service (Alby Hub, CoinOS) or direct LND.`,
      });
    }

    // ---- Origin protection (the single most money-relevant check) ----
    const originIds = [...new Set(rows.map((r) => r.originId).filter((id): id is string => !!id))];
    const checkedOrigins = originIds.slice(0, ORIGIN_CHECK_CAP);
    if (originIds.length > checkedOrigins.length) {
      notes.push(`Origin probes capped at ${ORIGIN_CHECK_CAP} — ${originIds.length - checkedOrigins.length} origin(s) not probed this run.`);
    }
    for (const originId of checkedOrigins) {
      const baseUrlOfOrigin =
        rows.find((r) => r.originId === originId)?.origin?.baseUrl ?? originId;
      const { check } = await apiRequest<{ check: OriginCheck }>(
        baseUrl,
        `/tenants/${tenant.id}/origins/${originId}/check`,
        { method: "POST", token: authToken },
      );
      switch (check.verdict) {
        case "public":
          findings.push({
            severity: "HIGH",
            text: `[origin] ${baseUrlOfOrigin} answers unsigned traffic (HTTP ${check.unsigned.statusCode}) — anyone can bypass the paywall and call it free ("a free API with extra steps"). Fix: enforce the gateway signature check on your origin (dashboard → Origins → Protection guide), or use a no-code platform rule / the bolthub-shield proxy: https://docs.bolthub.ai/docs/guides/origin-protection#no-code-platform-recipes`,
          });
          break;
        case "broken":
          findings.push({
            severity: "HIGH",
            text: `[origin] ${baseUrlOfOrigin} REJECTS bolthub's signed traffic (HTTP ${check.signed.statusCode}) — paying buyers are getting errors right now. Fix: check the HMAC secret and verified path in your origin protection setup (did the secret rotate?).`,
          });
          break;
        case "unreachable":
          findings.push({
            severity: "HIGH",
            text: `[origin] ${baseUrlOfOrigin} did not answer either probe — the listing is effectively down. Fix: check the origin's availability and DNS.`,
          });
          break;
        case "inconclusive":
          findings.push({
            severity: "LOW",
            text: `[origin] ${baseUrlOfOrigin}: protection could not be confirmed (unsigned probe got HTTP ${check.unsigned.statusCode ?? "no response"} at the base URL — not an explicit 401/403). If the base path just 404s, this may be fine; verify with a real endpoint path.`,
          });
          break;
        // "protected" is the good case — no finding.
      }
    }

    // ---- Public spec visibility ----
    let specPaths: Set<string> | null = null;
    try {
      const res = await fetch(`${baseUrl}/gw/${tenant.slug}/.well-known/openapi.json`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const spec = (await res.json()) as { paths?: Record<string, Record<string, unknown>> };
        specPaths = new Set(
          Object.entries(spec.paths ?? {}).flatMap(([p, item]) =>
            Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`),
          ),
        );
      }
    } catch {
      // Spec fetch is best-effort; the check is skipped below when null.
    }
    if (specPaths) {
      const published = rows.filter((r) => r.directoryListed && r.isActive);
      const missing = published.filter((r) => !specPaths!.has(label(r)));
      if (missing.length > 0) {
        findings.push({
          severity: "MED",
          text: `[schema] ${missing.length} published endpoint(s) missing from the public OpenAPI agents read (${nameList(missing)}). Fix: re-check isActive/directoryListed; if just published, the discovery doc may still be cached a few minutes.`,
        });
      }
    } else {
      notes.push("Public /.well-known/openapi.json was not reachable — schema-visibility check skipped.");
    }

    // ---- Per-endpoint health + usage (detailed set) ----
    const detailRows = rows.slice(0, DETAIL_CAP);
    if (rows.length > detailRows.length) {
      notes.push(`Health/usage detail capped at ${DETAIL_CAP} of ${rows.length} endpoints.`);
    }
    const lowUptime: string[] = [];
    const slowP95: string[] = [];
    const dishonest: string[] = [];
    const lowTraffic = new Set<string>();
    for (const row of detailRows) {
      const [health, logs] = await Promise.all([
        apiRequest<HealthResponse>(
          baseUrl,
          `/tenants/${tenant.id}/endpoints/${row.id}/health?limit=1`,
          { token: authToken },
        ),
        apiRequest<LogsSummary>(
          baseUrl,
          `/tenants/${tenant.id}/endpoints/${row.id}/logs/summary`,
          { token: authToken },
        ),
      ]);
      if (health.uptimePercentage != null && health.uptimePercentage < UPTIME_FLOOR_PCT) {
        lowUptime.push(`${label(row)} (${health.uptimePercentage.toFixed(1)}%)`);
      }
      if (logs.p95LatencyMs > P95_CEILING_MS) {
        slowP95.push(`${label(row)} (p95 ${Math.round(logs.p95LatencyMs)}ms)`);
      }
      if (logs.totalRequests < 50) lowTraffic.add(row.id);
      const hard =
        logs.errorBreakdown.timeout + logs.errorBreakdown.connectionError + logs.errorBreakdown.origin5xx;
      if (logs.totalRequests >= MIN_TRAFFIC_FOR_ERROR_CHECK && hard / logs.totalRequests > HARD_FAIL_SHARE) {
        dishonest.push(
          `${label(row)} (${logs.errorBreakdown.origin5xx}×5xx, ${logs.errorBreakdown.timeout}×timeout, ${logs.errorBreakdown.connectionError}×conn of ${logs.totalRequests})`,
        );
      }
    }
    if (dishonest.length > 0) {
      findings.push({
        severity: "HIGH",
        text: `[errors] Buyers are paying for failures on: ${dishonest.join("; ")}. Fix: resolve origin 5xx/timeouts, or return honest 4xx for bad input so callers can correct instead of retrying.`,
      });
    }
    if (lowUptime.length > 0) {
      findings.push({
        severity: "MED",
        text: `[uptime] Below the ${UPTIME_FLOOR_PCT}% floor: ${lowUptime.join(", ")}. Fix: stabilize the origin; sustained dips also flip the endpoint unhealthy in the directory.`,
      });
    }
    if (slowP95.length > 0) {
      findings.push({
        severity: "MED",
        text: `[latency] p95 above ${P95_CEILING_MS / 1000}s: ${slowP95.join(", ")}. Fix: agents time out and don't retry paid calls kindly — cache or speed up the origin.`,
      });
    }

    // ---- Structural checks (every endpoint) ----
    const noDescription = rows.filter((r) => !r.description || r.description.length < 20);
    if (noDescription.length > 0) {
      findings.push({
        severity: "MED",
        text: `[docs] Missing/thin descriptions (<20 chars) on ${noDescription.length} endpoint(s): ${nameList(noDescription)}. Fix: agents pick APIs by description — say what it returns and when to use it.`,
      });
    }
    const undocumentedParams = rows.filter(
      (r) => r.path.includes("{") && (!r.parameters || r.parameters.length === 0),
    );
    if (undocumentedParams.length > 0) {
      findings.push({
        severity: "MED",
        text: `[docs] Path parameters undocumented on: ${nameList(undocumentedParams)}. Fix: add parameter names/descriptions so agents can construct calls without guessing.`,
      });
    }
    const noExamples = rows.filter(
      (r) => !r.exampleRequest && !r.exampleResponse && !r.latestSampleId,
    );
    if (noExamples.length > 0) {
      findings.push({
        severity: "MED",
        text: `[docs] No example request/response or captured sample on: ${nameList(noExamples)}. Fix: add examples or run "Refresh samples" in the dashboard — buyers preview before paying.`,
      });
    }
    const unpriced = rows.filter((r) => !r.pricingRules?.length);
    if (unpriced.length > 0) {
      findings.push({
        severity: "HIGH",
        text: `[pricing] No pricing rule on: ${nameList(unpriced)}. Fix: set pricing (dashboard → Endpoints, or re-run list_api pricing) — unpriced endpoints can't be sold.`,
      });
    }
    const modelMismatch = rows
      .map((r) => {
        const rule = r.pricingRules?.[0];
        if (!rule || rule.pricingModel !== "per_request") return null;
        const suggestion = pricingSuggestion({
          method: r.method,
          path: r.path,
          title: r.title ?? undefined,
          exampleResponse: r.exampleResponse ?? undefined,
        });
        return suggestion ? `${label(r)} — ${suggestion}` : null;
      })
      .filter((s): s is string => s !== null);
    if (modelMismatch.length > 0) {
      findings.push({
        severity: "MED",
        text: `[pricing] Model may not fit the workload:\n    ${modelMismatch.join("\n    ")}`,
      });
    }
    const noSample = rows.filter((r) => !r.latestSampleId && (r.exampleRequest || r.exampleResponse));
    if (noSample.length > 0) {
      findings.push({
        severity: "LOW",
        text: `[samples] Documented examples but no live captured sample on: ${nameList(noSample)}. Fix: "Refresh samples" keeps the directory preview real.`,
      });
    }
    // Only endpoints whose traffic we actually measured — an unmeasured
    // endpoint may be busy, where free-try just gives revenue away.
    const noFreeTry = rows.filter(
      (r) => r.directoryListed && !r.freeTryEnabled && lowTraffic.has(r.id),
    );
    if (noFreeTry.length > 0) {
      findings.push({
        severity: "LOW",
        text: `[discovery] Free-try disabled on low-traffic endpoint(s): ${nameList(noFreeTry)}. Fix: one free call per buyer removes the try-before-buy barrier while you're building reputation.`,
      });
    }

    // ---- Report ----
    const order: Severity[] = ["HIGH", "MED", "LOW"];
    const lines: string[] = [
      `Listing audit — workspace "${tenant.name}", ${rows.length} endpoint(s) checked.`,
      "Read-only: this audit changed nothing.",
      "",
    ];
    const highCount = findings.filter((f) => f.severity === "HIGH").length;
    if (findings.length === 0) {
      lines.push("No findings — the listing passes every rubric check this audit can run.");
    } else {
      if (highCount === 0) {
        lines.push("No HIGH findings — nothing blocking sales. Punch list below.", "");
      }
      for (const sev of order) {
        const group = findings.filter((f) => f.severity === sev);
        if (group.length === 0) continue;
        lines.push(`${sev}:`);
        lines.push(...group.map((f) => `  - ${f.text}`));
        lines.push("");
      }
    }
    lines.push("Notes:");
    lines.push(...notes.map((n) => `  - ${n}`));
    return textResult(lines.join("\n"));
  } catch (err) {
    return errorResult(
      `analyze_listing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Revenue tools (GR-T5; design in docs/design/growth/DESIGN-AGENT-TOOLS.md):
 * `get_earnings` and `usage_summary` — read-only wrappers over the existing
 * analytics/billing/facilitator routes. No new API surface; the receipts-
 * canonical revenue definition (invoices settled ∨ consumed) is whatever
 * those routes return.
 */

import { apiRequest } from "./node-tools.js";
import { requireAuth, resolveTenant, errorResult, textResult } from "./seller-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_API_URL = "https://api.bolthub.ai";
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

const sats = (n: number) => `${Math.round(n).toLocaleString("en-US")} sats`;

function clampDays(days: number | undefined): number | { error: ToolResult } {
  if (days === undefined) return DEFAULT_DAYS;
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
    return { error: errorResult(`days must be between 1 and ${MAX_DAYS}.`) };
  }
  return Math.floor(days);
}

interface TopEndpointRow {
  endpointId?: string | null;
  path?: string | null;
  title?: string | null;
  method?: string | null;
  totalSats: number;
  totalRequests: number;
}

const topLabel = (row: TopEndpointRow): string =>
  [row.method, row.path ?? row.title ?? row.endpointId ?? "unknown endpoint"]
    .filter(Boolean)
    .join(" ");

export async function handleGetEarnings(
  args: { tenant_id?: string; days?: number },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  const authError = requireAuth(authToken);
  if (authError) return authError;
  const days = clampDays(args.days);
  if (typeof days !== "number") return days.error;

  try {
    const resolved = await resolveTenant(baseUrl, authToken!, args.tenant_id);
    if ("error" in resolved) return resolved.error;
    const tenant = resolved.tenant;

    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const [overview, revenue, top] = await Promise.all([
      apiRequest<{ totalInvoices: number; settledInvoices: number; totalSatsEarned: number }>(
        baseUrl,
        `/tenants/${tenant.id}/analytics/overview`,
        { token: authToken },
      ),
      apiRequest<{ data: Array<{ date: string; sats: number; count: number }> }>(
        baseUrl,
        `/tenants/${tenant.id}/analytics/revenue?start=${start.toISOString()}&end=${end.toISOString()}`,
        { token: authToken },
      ),
      apiRequest<{ data: TopEndpointRow[] }>(
        baseUrl,
        `/tenants/${tenant.id}/analytics/top-endpoints`,
        { token: authToken },
      ),
    ]);

    const windowSats = revenue.data.reduce((sum, d) => sum + d.sats, 0);
    const windowCount = revenue.data.reduce((sum, d) => sum + d.count, 0);

    const lines: string[] = [
      `Earnings — workspace "${tenant.name}"`,
      "",
      `All time: ${sats(overview.totalSatsEarned)} across ${overview.settledInvoices} paid invoice(s).`,
      `Last ${days} day(s): ${sats(windowSats)} over ${windowCount} paid invoice(s).`,
    ];

    const activeDays = revenue.data.filter((d) => d.sats > 0);
    if (activeDays.length > 0) {
      lines.push("", "Recent paid days:");
      lines.push(...activeDays.slice(-7).map((d) => `  ${d.date}: ${sats(d.sats)} (${d.count})`));
    }

    if (top.data.length > 0) {
      lines.push("", "Top endpoints (all time):");
      lines.push(
        ...top.data.map(
          (row, i) => `  ${i + 1}. ${topLabel(row)} — ${sats(row.totalSats)} / ${row.totalRequests} paid request(s)`,
        ),
      );
    }

    if (overview.totalSatsEarned === 0) {
      lines.push(
        "",
        "No revenue yet. Run analyze_listing for a sale-readiness punch list, and check the listing is published (publish_listing dry run shows the current state).",
      );
    }
    return textResult(lines.join("\n"));
  } catch (err) {
    return errorResult(`get_earnings failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface BillingSummary {
  requestCount: number;
  freeRequestsRemaining: number;
  projectedUsageFeeSats: number;
  projectedTotalSats: number;
  monthlyBaseFeeSats: number;
  billingStatus: string;
  isTrial: boolean;
  isVip: boolean;
  trialEndsAt: string | null;
  autoPayEnabled: boolean;
}

interface LogsSummary {
  totalRequests: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorBreakdown: { timeout: number; connectionError: number; origin5xx: number; origin4xx: number };
}

export async function handleUsageSummary(
  args: { tenant_id?: string; endpoint_id?: string; days?: number },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  const authError = requireAuth(authToken);
  if (authError) return authError;
  const days = clampDays(args.days);
  if (typeof days !== "number") return days.error;

  try {
    const resolved = await resolveTenant(baseUrl, authToken!, args.tenant_id);
    if ("error" in resolved) return resolved.error;
    const tenant = resolved.tenant;

    const lines: string[] = [`Usage — workspace "${tenant.name}"`, ""];

    // Per-endpoint drill-down: the gateway usage log summary.
    if (args.endpoint_id) {
      const logs = await apiRequest<LogsSummary>(
        baseUrl,
        `/tenants/${tenant.id}/endpoints/${args.endpoint_id}/logs/summary`,
        { token: authToken },
      );
      const e = logs.errorBreakdown;
      lines.push(
        `Endpoint ${args.endpoint_id}:`,
        `  Requests: ${logs.totalRequests.toLocaleString("en-US")} · success ${logs.successRate}%`,
        `  Latency: avg ${logs.avgLatencyMs}ms · p95 ${logs.p95LatencyMs}ms`,
        `  Errors: ${e.origin5xx}×origin-5xx, ${e.origin4xx}×origin-4xx, ${e.timeout}×timeout, ${e.connectionError}×connection`,
      );
      return textResult(lines.join("\n"));
    }

    const [billingRes, facilitator, top] = await Promise.all([
      apiRequest<{ billing: BillingSummary | null }>(baseUrl, `/tenants/${tenant.id}/billing`, {
        token: authToken,
      }),
      apiRequest<{ totals?: { paidCalls?: number; amount?: number } | null }>(
        baseUrl,
        `/tenants/${tenant.id}/facilitator/usage?days=${days}`,
        { token: authToken },
      ).catch(() => null),
      apiRequest<{ data: TopEndpointRow[] }>(
        baseUrl,
        `/tenants/${tenant.id}/analytics/top-endpoints`,
        { token: authToken },
      ),
    ]);

    const billing = billingRes.billing;
    if (billing) {
      const status = billing.isVip
        ? "VIP (fees waived)"
        : billing.isTrial
          ? `trial${billing.trialEndsAt ? ` (ends ${billing.trialEndsAt.slice(0, 10)})` : ""}`
          : billing.billingStatus;
      lines.push(
        `Billing: ${status}`,
        `  This cycle: ${billing.requestCount.toLocaleString("en-US")} request(s) · ${billing.freeRequestsRemaining.toLocaleString("en-US")} free remaining`,
        `  Projected platform fee: ${sats(billing.projectedTotalSats)}${
          billing.projectedTotalSats > 0
            ? ` (base ${sats(billing.monthlyBaseFeeSats)} + usage ${sats(billing.projectedUsageFeeSats)})`
            : ""
        }`,
        `  Auto-pay: ${billing.autoPayEnabled ? "on" : "off"}`,
      );
    } else {
      lines.push("Billing: no billing record yet (nothing published).");
    }

    if (top.data.length > 0) {
      lines.push("", "Paid gateway traffic by endpoint (all time):");
      lines.push(
        ...top.data.map(
          (row) => `  ${topLabel(row)} — ${row.totalRequests.toLocaleString("en-US")} paid request(s), ${sats(row.totalSats)}`,
        ),
      );
    } else {
      lines.push("", "No paid gateway traffic yet.");
    }

    if (facilitator?.totals && (facilitator.totals.paidCalls ?? 0) > 0) {
      lines.push(
        "",
        `SDK tools (last ${days} day(s)): ${facilitator.totals.paidCalls} paid call(s), ${sats(facilitator.totals.amount ?? 0)}.`,
      );
    }

    lines.push("", "Tip: pass endpoint_id for latency/error detail on one endpoint.");
    return textResult(lines.join("\n"));
  } catch (err) {
    return errorResult(`usage_summary failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

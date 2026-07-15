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

/**
 * Zero-revenue hint, aware of WHY it's zero (L3): quotes-but-no-payments
 * points at payability (the smoke-test failure mode: reachable node, no
 * inbound liquidity), no-quotes points at publish/directory state. The
 * extra endpoints request only happens on the zero-revenue path.
 */
async function earningsEmptyStateHint(
  baseUrl: string,
  authToken: string,
  tenant: { id: string; directoryListed: boolean; walletReachable?: boolean | null },
  totalInvoices: number,
): Promise<string> {
  if (totalInvoices > 0) {
    const walletNote =
      tenant.walletReachable === false
        ? "The payout wallet is currently unreachable, so no payment can settle: node_status shows what's wrong."
        : "First check the wallet can actually RECEIVE: node_status shows inbound capacity (a reachable node with zero inbound liquidity fails every payment).";
    return (
      `No revenue yet, but ${totalInvoices} payment quote(s) were issued and none were paid. ` +
      `${walletNote} Then reconsider pricing (analyze_listing compares against the marketplace).`
    );
  }
  try {
    const { endpoints } = await apiRequest<{ endpoints: Array<{ isActive: boolean }> }>(
      baseUrl,
      `/tenants/${tenant.id}/endpoints`,
      { token: authToken },
    );
    if (!endpoints.some((e) => e.isActive)) {
      return "No revenue yet: nothing is published, so buyers can't reach a paywall. publish_listing publishes your endpoints (the dry run shows what would go live).";
    }
    if (!tenant.directoryListed) {
      return "No revenue yet: endpoints are published but the workspace isn't listed in the marketplace directory, so buyers can't find them. publish_listing can list it; analyze_listing gives a sale-readiness punch list.";
    }
  } catch {
    // Endpoint state unavailable (older API, transient failure): fall back
    // to the generic hint rather than failing the whole earnings report.
  }
  return "No revenue yet. Run analyze_listing for a sale-readiness punch list, and check the listing is published (publish_listing dry run shows the current state).";
}

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
      apiRequest<{
        totalInvoices: number;
        settledInvoices: number;
        totalSatsEarned: number;
        // Present on API >= the M4 deploy; older APIs omit them.
        unredeemedInvoices?: number;
        unredeemedSats?: number;
        consumedInvoices?: number;
      }>(baseUrl, `/tenants/${tenant.id}/analytics/overview`, { token: authToken }),
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

    // Disclosure, not accounting: unredeemed sats are already inside the
    // totals above (the payment settled to the seller's wallet), the buyer
    // just never spent the L402 credential on a request.
    if ((overview.unredeemedInvoices ?? 0) > 0) {
      lines.push(
        `Paid but not yet redeemed: ${overview.unredeemedInvoices} invoice(s) holding ${sats(overview.unredeemedSats ?? 0)}. ` +
          `The sats are on your wallet and included in the totals above; the buyer paid the quote but has not used the credential on a request yet.`,
      );
    }
    if (overview.consumedInvoices !== undefined && overview.totalInvoices > 0) {
      const paid = overview.settledInvoices;
      const paidPct = Math.round((paid / overview.totalInvoices) * 100);
      const redeemedPct = paid > 0 ? Math.round((overview.consumedInvoices / paid) * 100) : 0;
      lines.push(
        `Quote conversion: ${overview.totalInvoices} quoted → ${paid} paid (${paidPct}%) → ${overview.consumedInvoices} redeemed (${redeemedPct}% of paid).`,
      );
    }

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
        await earningsEmptyStateHint(baseUrl, authToken!, tenant, overview.totalInvoices),
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
      // trialEndsAt null = the trial clock has not started: it starts at the
      // first PUBLISHED endpoint (usage-gated billing), so a draft-only
      // workspace showing a bare "trial" reads like a ticking clock (M2).
      const status = billing.isVip
        ? "VIP (fees waived)"
        : billing.isTrial
          ? billing.trialEndsAt
            ? `trial (ends ${billing.trialEndsAt.slice(0, 10)})`
            : "trial (not started: the 30-day clock starts when you publish your first endpoint)"
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

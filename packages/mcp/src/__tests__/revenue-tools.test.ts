import { describe, test, expect, afterEach } from "bun:test";
import { handleGetEarnings, handleUsageSummary } from "../sources/revenue-tools";

const API = "https://api.test";
const TOKEN = "jwt-secret-token";

interface Recorded {
  method: string;
  path: string;
  search: string;
}

const originalFetch = globalThis.fetch;
let recorded: Recorded[] = [];

function mockApi(routes: Record<string, unknown>) {
  recorded = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    recorded.push({ method, path: url.pathname, search: url.search });
    const payload = routes[`${method} ${url.pathname}`];
    if (payload === undefined) {
      return new Response(JSON.stringify({ error: `no mock for ${method} ${url.pathname}` }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TENANT = { id: "t-1", name: "Acme Data", slug: "acme", status: "active", directoryListed: true };

const OVERVIEW = { totalInvoices: 80, settledInvoices: 64, totalSatsEarned: 3200 };
const REVENUE = {
  data: [
    { date: "2026-07-10", sats: 100, count: 20 },
    { date: "2026-07-11", sats: 0, count: 0 },
    { date: "2026-07-12", sats: 250, count: 44 },
  ],
};
const TOP = {
  data: [
    { endpointId: "ep-1", method: "GET", path: "/v1/things", totalSats: 3000, totalRequests: 600 },
    { endpointId: "ep-2", method: "POST", path: "/v1/compute", totalSats: 200, totalRequests: 4 },
  ],
};

describe("handleGetEarnings", () => {
  test("refuses without an auth token", async () => {
    mockApi({});
    const result = await handleGetEarnings({}, API, undefined);
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  test("rejects out-of-range windows", async () => {
    mockApi({});
    expect((await handleGetEarnings({ days: 0 }, API, TOKEN)).isError).toBe(true);
    expect((await handleGetEarnings({ days: 9999 }, API, TOKEN)).isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  test("reports all-time, window, paid days, and top endpoints; read-only", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/analytics/overview": OVERVIEW,
      "GET /tenants/t-1/analytics/revenue": REVENUE,
      "GET /tenants/t-1/analytics/top-endpoints": TOP,
    });
    const result = await handleGetEarnings({ days: 7 }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("3,200 sats across 64 paid invoice(s)");
    expect(text).toContain("Last 7 day(s): 350 sats over 64 paid invoice(s)");
    expect(text).toContain("2026-07-12: 250 sats (44)");
    expect(text).not.toContain("2026-07-11"); // zero days omitted
    expect(text).toContain("1. GET /v1/things — 3,000 sats / 600 paid request(s)");
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
    const revenueCall = recorded.find((r) => r.path.endsWith("/analytics/revenue"))!;
    expect(revenueCall.search).toContain("start=");
    expect(revenueCall.search).toContain("end=");
    expect(text).not.toContain(TOKEN);
  });

  test("zero revenue points at analyze_listing and publish_listing", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/analytics/overview": { totalInvoices: 0, settledInvoices: 0, totalSatsEarned: 0 },
      "GET /tenants/t-1/analytics/revenue": { data: [] },
      "GET /tenants/t-1/analytics/top-endpoints": { data: [] },
    });
    const result = await handleGetEarnings({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("analyze_listing");
    expect(text).toContain("publish_listing");
  });
});

describe("handleUsageSummary", () => {
  const BILLING = {
    billing: {
      requestCount: 1234,
      freeRequestsRemaining: 0,
      projectedUsageFeeSats: 600,
      projectedTotalSats: 5600,
      monthlyBaseFeeSats: 5000,
      billingStatus: "trial",
      isTrial: true,
      isVip: false,
      trialEndsAt: "2026-08-05T00:00:00.000Z",
      autoPayEnabled: true,
    },
  };

  test("workspace rollup: billing, gateway traffic, SDK tools", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/billing": BILLING,
      "GET /tenants/t-1/facilitator/usage": { totals: { paidCalls: 12, amount: 60 } },
      "GET /tenants/t-1/analytics/top-endpoints": TOP,
    });
    const result = await handleUsageSummary({}, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("trial (ends 2026-08-05)");
    expect(text).toContain("1,234 request(s)");
    expect(text).toContain("5,600 sats (base 5,000 sats + usage 600 sats)");
    expect(text).toContain("GET /v1/things — 600 paid request(s), 3,000 sats");
    expect(text).toContain("SDK tools (last 30 day(s)): 12 paid call(s), 60 sats");
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
  });

  test("facilitator route failure is tolerated (older API)", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/billing": BILLING,
      "GET /tenants/t-1/analytics/top-endpoints": { data: [] },
    });
    const result = await handleUsageSummary({}, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No paid gateway traffic yet");
  });

  test("endpoint_id drill-down uses the logs summary", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/endpoints/ep-1/logs/summary": {
        totalRequests: 900,
        successRate: 97.5,
        avgLatencyMs: 120,
        p95LatencyMs: 850,
        errorBreakdown: { timeout: 3, connectionError: 0, origin5xx: 5, origin4xx: 14 },
      },
    });
    const result = await handleUsageSummary({ endpoint_id: "ep-1" }, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("success 97.5%");
    expect(text).toContain("p95 850ms");
    expect(text).toContain("5×origin-5xx");
    expect(recorded.some((r) => r.path.endsWith("/billing"))).toBe(false);
  });

  test("VIP billing renders as fees waived", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/billing": {
        billing: { ...BILLING.billing, isVip: true, isTrial: false, projectedTotalSats: 0, projectedUsageFeeSats: 0 },
      },
      "GET /tenants/t-1/facilitator/usage": { totals: { paidCalls: 0, amount: 0 } },
      "GET /tenants/t-1/analytics/top-endpoints": { data: [] },
    });
    const result = await handleUsageSummary({}, API, TOKEN);
    expect(result.content[0].text).toContain("VIP (fees waived)");
  });
});

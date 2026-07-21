import { describe, test, expect, afterEach } from "bun:test";
import { handleAnalyzeListing, DETAIL_CAP } from "../sources/analyze-tools";

// Same mocked-fetch router as seller-tools.test.ts: responses keyed by
// "METHOD /path", every request recorded for assertions.

const API = "https://api.test";
const TOKEN = "jwt-secret-token";

interface Recorded {
  method: string;
  path: string;
}

const originalFetch = globalThis.fetch;
let recorded: Recorded[] = [];

function mockApi(routes: Record<string, unknown>, fallback?: (key: string) => unknown) {
  recorded = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    recorded.push({ method, path: url.pathname });
    const key = `${method} ${url.pathname}`;
    const payload = routes[key] ?? fallback?.(key);
    if (payload === undefined) {
      return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404 });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TENANT = {
  id: "t-1",
  name: "Acme Data",
  slug: "acme",
  status: "active",
  directoryListed: true,
};

const HEALTHY = { isHealthy: true, uptimePercentage: 99.9, avgResponseTimeMs: 120 };
const QUIET_LOGS = {
  totalRequests: 500,
  successRate: 100,
  avgLatencyMs: 90,
  p95LatencyMs: 300,
  errorBreakdown: { timeout: 0, connectionError: 0, origin5xx: 0, origin4xx: 0 },
};

function endpointRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ep-1",
    path: "/v1/things",
    method: "GET",
    title: "List things",
    description: "Returns every thing we know about, paginated and filterable.",
    parameters: [{ name: "page", in: "query" }],
    exampleRequest: null,
    exampleResponse: { things: [] },
    latestSampleId: "s-1",
    freeTryEnabled: true,
    isActive: true,
    directoryListed: true,
    originId: "o-1",
    origin: { id: "o-1", baseUrl: "https://origin.example.com" },
    pricingRules: [{ pricingModel: "per_request", priceSats: 5 }],
    ...overrides,
  };
}

const GOOD_SPEC = { paths: { "/v1/things": { get: {} } } };

function baseRoutes(rows: unknown[], checkVerdict = "protected"): Record<string, unknown> {
  return {
    "GET /tenants": { tenants: [TENANT] },
    "GET /tenants/t-1/endpoints": { endpoints: rows },
    "POST /tenants/t-1/origins/o-1/check": {
      check: { verdict: checkVerdict, signed: { statusCode: 200 }, unsigned: { statusCode: 403 } },
    },
    "GET /gw/acme/.well-known/openapi.json": GOOD_SPEC,
    "GET /tenants/t-1/endpoints/ep-1/health": HEALTHY,
    "GET /tenants/t-1/endpoints/ep-1/logs/summary": QUIET_LOGS,
  };
}

describe("handleAnalyzeListing", () => {
  test("refuses without an auth token, before any network call", async () => {
    mockApi({});
    const result = await handleAnalyzeListing({}, API, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("BOLTHUB_ACCOUNT_TOKEN");
    expect(recorded).toHaveLength(0);
  });

  test("clean listing reports no findings and stays read-only", async () => {
    mockApi(baseRoutes([endpointRow()]));
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No findings");
    // Even a clean report names every rubric area, so silence ≠ not-run.
    expect(result.content[0].text).toContain("Rubric coverage:");
    // only the origin-check probe is a POST; everything else must be GET
    const writes = recorded.filter((r) => r.method !== "GET");
    expect(writes).toEqual([{ method: "POST", path: "/tenants/t-1/origins/o-1/check" }]);
  });

  test("bare draft-only listing mentions docs/samples/free-try one way or the other", async () => {
    // 2026-07-16 smoke finding: a fresh list_api import (no descriptions,
    // no examples, no samples, drafts unlisted, zero traffic) produced an
    // audit with only the origin finding — the inapplicable checks vanished
    // silently and the report read as complete.
    const bareDraft = (id: string, path: string) =>
      endpointRow({
        id,
        path,
        title: null,
        description: null,
        parameters: null,
        exampleRequest: null,
        exampleResponse: null,
        latestSampleId: null,
        freeTryEnabled: false,
        directoryListed: false,
      });
    const zeroLogs = {
      totalRequests: 0,
      successRate: 0,
      p95LatencyMs: 0,
      errorBreakdown: { timeout: 0, connectionError: 0, origin5xx: 0, origin4xx: 0 },
    };
    const noHealth = { isHealthy: true, uptimePercentage: null, avgResponseTimeMs: null };
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/endpoints": { endpoints: [bareDraft("ep-1", "/get"), bareDraft("ep-2", "/json")] },
      "POST /tenants/t-1/origins/o-1/check": {
        check: { verdict: "public", signed: { statusCode: 200 }, unsigned: { statusCode: 200 } },
      },
      "GET /tenants/t-1/endpoints/ep-1/health": noHealth,
      "GET /tenants/t-1/endpoints/ep-2/health": noHealth,
      "GET /tenants/t-1/endpoints/ep-1/logs/summary": zeroLogs,
      "GET /tenants/t-1/endpoints/ep-2/logs/summary": zeroLogs,
      // no .well-known route → spec fetch 404s → schema check skipped
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    const text = result.content[0].text;
    expect(result.isError).toBeUndefined();
    // The structural checks fire on genuinely bare drafts…
    expect(text).toContain("Missing/thin descriptions");
    expect(text).toContain("No example request/response or captured sample");
    // …and every inapplicable rubric area is disclosed, not omitted.
    expect(text).toContain("free-try skipped (drafts only");
    expect(text).toContain("traffic quality (uptime/latency/error honesty) skipped (no traffic yet)");
    expect(text).toContain("schema visibility skipped");
    expect(text).toContain("402-challenge rate not auditable in v1");
    expect(text).toContain("samples ✓");
  });

  test("public origin verdict is a HIGH finding", async () => {
    mockApi({
      ...baseRoutes([endpointRow()]),
      "POST /tenants/t-1/origins/o-1/check": {
        check: { verdict: "public", signed: { statusCode: 200 }, unsigned: { statusCode: 200 } },
      },
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("HIGH:");
    expect(text).toContain("free API with extra steps");
    expect(text).toContain("https://origin.example.com");
  });

  test("broken origin verdict says paying buyers are failing", async () => {
    mockApi({
      ...baseRoutes([endpointRow()]),
      "POST /tenants/t-1/origins/o-1/check": {
        check: { verdict: "broken", signed: { statusCode: 403 }, unsigned: { statusCode: 403 } },
      },
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.content[0].text).toContain("REJECTS bolthub's signed traffic");
  });

  test("structural findings: thin description, missing examples, unpriced, undocumented path params", async () => {
    const rows = [
      endpointRow({
        id: "ep-1",
        description: "short",
        exampleRequest: null,
        exampleResponse: null,
        latestSampleId: null,
        pricingRules: [],
        path: "/v1/things/{id}",
        parameters: [],
      }),
    ];
    mockApi({
      ...baseRoutes(rows),
      "GET /gw/acme/.well-known/openapi.json": { paths: { "/v1/things/{id}": { get: {} } } },
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("Missing/thin descriptions");
    expect(text).toContain("Path parameters undocumented");
    expect(text).toContain("No example request/response");
    expect(text).toContain("No pricing rule");
    expect(text).toContain("HIGH:");
  });

  test("dishonest status codes over the threshold are HIGH", async () => {
    mockApi({
      ...baseRoutes([endpointRow()]),
      "GET /tenants/t-1/endpoints/ep-1/logs/summary": {
        ...QUIET_LOGS,
        totalRequests: 100,
        errorBreakdown: { timeout: 4, connectionError: 0, origin5xx: 6, origin4xx: 2 },
      },
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.content[0].text).toContain("paying for failures");
  });

  test("published endpoint missing from the public spec is flagged", async () => {
    mockApi({
      ...baseRoutes([endpointRow()]),
      "GET /gw/acme/.well-known/openapi.json": { paths: {} },
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.content[0].text).toContain("missing from the public OpenAPI");
  });

  test("unreachable spec is a note, not a failure", async () => {
    const routes = baseRoutes([endpointRow()]);
    delete (routes as Record<string, unknown>)["GET /gw/acme/.well-known/openapi.json"];
    mockApi(routes);
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("schema-visibility check skipped");
  });

  test("per_request on a compute-shaped endpoint suggests a better model", async () => {
    mockApi({
      ...baseRoutes([endpointRow({ path: "/v1/generate-report", title: "Generate report" })]),
      "GET /gw/acme/.well-known/openapi.json": { paths: { "/v1/generate-report": { get: {} } } },
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.content[0].text).toContain("consider metered");
  });

  test("endpoint_id narrows the audit and rejects unknown ids", async () => {
    mockApi(baseRoutes([endpointRow()]));
    const unknown = await handleAnalyzeListing({ endpoint_id: "nope" }, API, TOKEN);
    expect(unknown.isError).toBe(true);

    mockApi(baseRoutes([endpointRow(), endpointRow({ id: "ep-2", path: "/v1/other", description: null })]));
    const result = await handleAnalyzeListing({ endpoint_id: "ep-1" }, API, TOKEN);
    // ep-2's thin description must not appear when auditing only ep-1
    expect(result.content[0].text).not.toContain("/v1/other");
  });

  test("detail sweep is capped and the cap is disclosed", async () => {
    const rows = Array.from({ length: DETAIL_CAP + 10 }, (_, i) =>
      endpointRow({ id: `ep-${i}`, path: `/v1/p${i}` }),
    );
    mockApi(
      {
        "GET /tenants": { tenants: [TENANT] },
        "GET /tenants/t-1/endpoints": { endpoints: rows },
        "POST /tenants/t-1/origins/o-1/check": {
          check: { verdict: "protected", signed: { statusCode: 200 }, unsigned: { statusCode: 403 } },
        },
        "GET /gw/acme/.well-known/openapi.json": {
          paths: Object.fromEntries(rows.map((r) => [(r as { path: string }).path, { get: {} }])),
        },
      },
      (key) => {
        if (key.endsWith("/logs/summary")) return QUIET_LOGS;
        if (key.includes("/health")) return HEALTHY;
        return undefined;
      },
    );
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.content[0].text).toContain(`capped at ${DETAIL_CAP}`);
    const healthCalls = recorded.filter((r) => r.path.includes("/health"));
    expect(healthCalls).toHaveLength(DETAIL_CAP);
  });

  test("empty workspace points at list_api", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/endpoints": { endpoints: [] },
    });
    const result = await handleAnalyzeListing({}, API, TOKEN);
    expect(result.content[0].text).toContain("list_api");
  });
});

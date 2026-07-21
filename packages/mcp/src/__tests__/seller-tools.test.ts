import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  handleListApi,
  handlePublishListing,
  sanitizeRow,
  pricingSuggestion,
  resolveAccountToken,
  IMPORT_CAP,
} from "../sources/seller-tools";

// The seller tools talk to the owner API with plain fetch (node-tools
// pattern), so tests route mocked responses by "METHOD /path" and record
// every request for body/header assertions.

const API = "https://api.test";
const TOKEN = "jwt-secret-token";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

const originalFetch = globalThis.fetch;
let recorded: Recorded[] = [];

function mockApi(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  recorded = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    recorded.push({
      method,
      path: url.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    const key = `${method} ${url.pathname}`;
    const handler = routes[key];
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404 });
    }
    const payload = typeof handler === "function" ? (handler as (b: unknown) => unknown)(body) : handler;
    // A route can return `{ __status, __body }` to simulate a non-2xx API
    // response (e.g. the WALLET_REQUIRED gate) — otherwise it's a 200.
    if (payload && typeof payload === "object" && "__status" in payload) {
      const p = payload as { __status: number; __body?: unknown };
      return new Response(JSON.stringify(p.__body ?? {}), { status: p.__status });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

const WALLET_REQUIRED_400 = {
  __status: 400,
  __body: {
    error: "Connect a Lightning wallet before publishing a paid endpoint.",
    code: "WALLET_REQUIRED",
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TENANT = {
  id: "t-1",
  name: "Acme Data",
  slug: "acme",
  status: "active",
  directoryListed: true,
  trialEndsAt: "2026-08-01T00:00:00Z",
};

const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  servers: [{ url: "https://origin.example.com" }],
  paths: {
    "/v1/things": {
      get: {
        summary: "List things",
        description: "Returns every thing we know about, paginated.",
      },
    },
    "/v1/compute": { post: { summary: "tiny" } },
  },
});

describe("handleListApi", () => {
  test("refuses without an auth token, before any network call", async () => {
    mockApi({});
    const result = await handleListApi({ spec_content: OPENAPI }, API, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("BOLTHUB_ACCOUNT_TOKEN");
    expect(recorded).toHaveLength(0);
  });

  test("requires exactly one of spec_url / spec_content", async () => {
    mockApi({});
    const neither = await handleListApi({}, API, TOKEN);
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toContain("spec_url");
    const both = await handleListApi({ spec_url: "https://x", spec_content: "{}" }, API, TOKEN);
    expect(both.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  test("enforces the 1-sat pricing floor", async () => {
    mockApi({});
    const result = await handleListApi({ spec_content: OPENAPI, price_sats: 0 }, API, TOKEN);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("at least 1 sat");
  });

  test("multi-workspace account without tenant_id lists workspaces and stops", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT, { ...TENANT, id: "t-2", name: "Other", slug: "other" }] },
    });
    const result = await handleListApi({ spec_content: OPENAPI }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("tenant_id");
    expect(result.content[0].text).toContain("t-2");
    expect(recorded.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  test("happy path: drafts created with explicit directoryListed:false + default pricing applied", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/origins": { origins: [] },
      "POST /tenants/t-1/endpoints/bulk": (body: unknown) => ({
        endpoints: (body as { endpoints: Array<{ path: string; method: string; title?: string }> }).endpoints.map(
          (e, i) => ({ id: `ep-${i}`, path: e.path, method: e.method, title: e.title ?? null }),
        ),
        skipped: [],
      }),
      "PUT /tenants/t-1/endpoints/bulk-pricing": { pricingRules: [] },
    });

    const result = await handleListApi({ spec_content: OPENAPI }, API, TOKEN);
    expect(result.isError).toBeUndefined();

    const bulk = recorded.find((r) => r.path === "/tenants/t-1/endpoints/bulk")!;
    const rows = (bulk.body as { endpoints: Array<Record<string, unknown>> }).endpoints;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.directoryListed).toBe(false);
      expect(row.originUrl).toBe("https://origin.example.com");
    }
    // the too-short description ("tiny" op has none ≥20 chars) is dropped
    const compute = rows.find((r) => r.path === "/v1/compute")!;
    expect(compute.description).toBeUndefined();

    const pricing = recorded.find((r) => r.path === "/tenants/t-1/endpoints/bulk-pricing")!;
    expect((pricing.body as { pricing: { priceSats: number; pricingModel: string } }).pricing).toEqual({
      pricingModel: "per_request",
      priceSats: 5,
    });

    // every authed request carried the bearer token; output never leaks it
    for (const r of recorded) {
      expect(r.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(result.content[0].text).not.toContain(TOKEN);
    expect(result.content[0].text).toContain("UNLISTED");
    expect(result.content[0].text).toContain("publish_listing");
    expect(result.content[0].text).toContain("https://acme.gw.bolthub.ai/v1/things");
  });

  test("caps hostile specs at IMPORT_CAP endpoints and says so", async () => {
    const bigSpec = {
      openapi: "3.0.0",
      servers: [{ url: "https://origin.example.com" }],
      paths: Object.fromEntries(
        Array.from({ length: IMPORT_CAP + 40 }, (_, i) => [
          `/v1/path-${i}`,
          { get: { summary: `Path ${i}` } },
        ]),
      ),
    };
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/origins": { origins: [] },
      "POST /tenants/t-1/endpoints/bulk": (body: unknown) => ({
        endpoints: (body as { endpoints: Array<{ path: string; method: string }> }).endpoints.map((e, i) => ({
          id: `ep-${i}`,
          path: e.path,
          method: e.method,
          title: null,
        })),
        skipped: [],
      }),
      "PUT /tenants/t-1/endpoints/bulk-pricing": { pricingRules: [] },
    });
    const result = await handleListApi({ spec_content: JSON.stringify(bigSpec) }, API, TOKEN);
    const bulk = recorded.find((r) => r.path === "/tenants/t-1/endpoints/bulk")!;
    expect((bulk.body as { endpoints: unknown[] }).endpoints).toHaveLength(IMPORT_CAP);
    expect(result.content[0].text).toContain("capped");
    expect(result.content[0].text).toContain("40");
  });

  test("spec without a base URL returns guidance instead of writing", async () => {
    const noServers = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/v1/x": { get: { summary: "X" } } },
    });
    mockApi({ "GET /tenants": { tenants: [TENANT] } });
    const result = await handleListApi({ spec_content: noServers }, API, TOKEN);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("origin_url");
    expect(recorded.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("existing origin with endpoints routes through sync dry-run, no writes", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/origins": {
        origins: [
          { id: "o-1", baseUrl: "https://origin.example.com", endpoints: [{ id: "ep-0" }] },
        ],
      },
      "POST /tenants/t-1/endpoints/sync": (body: unknown) => {
        expect((body as { dryRun?: boolean }).dryRun).toBe(true);
        return { diff: { added: 1, updated: 1, unchanged: 0 } };
      },
    });
    const result = await handleListApi({ spec_content: OPENAPI }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("re-import");
    expect(result.content[0].text).toContain("apply_sync");
    expect(recorded.some((r) => r.path.endsWith("/endpoints/bulk"))).toBe(false);
  });

  test("apply_sync:true applies the sync for real", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/origins": {
        origins: [
          { id: "o-1", baseUrl: "https://origin.example.com", endpoints: [{ id: "ep-0" }] },
        ],
      },
      "POST /tenants/t-1/endpoints/sync": (body: unknown) => {
        expect((body as { dryRun?: boolean }).dryRun).toBeUndefined();
        return { result: { added: 1, updated: 1 } };
      },
    });
    const result = await handleListApi({ spec_content: OPENAPI, apply_sync: true }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Sync applied");
  });
});

describe("handlePublishListing", () => {
  const DRAFTS = [
    {
      id: "ep-1",
      path: "/v1/things",
      method: "GET",
      title: "List things",
      isActive: true,
      directoryListed: false,
      pricingRules: [{ pricingModel: "per_request", priceSats: 5 }],
    },
    {
      id: "ep-2",
      path: "/v1/compute",
      method: "POST",
      title: null,
      isActive: true,
      directoryListed: false,
      pricingRules: [],
    },
  ];

  test("dry run (no confirm) summarizes and writes nothing", async () => {
    mockApi({
      "GET /tenants": { tenants: [{ ...TENANT, status: "onboarding", directoryListed: false, trialEndsAt: null }] },
      "GET /tenants/t-1/endpoints": { endpoints: DRAFTS },
    });
    const result = await handlePublishListing({}, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("DRY RUN");
    expect(text).toContain("2 endpoint(s) become visible");
    expect(text).toContain("ACTIVATED");
    expect(text).toContain("30-day free trial");
    expect(text).toContain("NO PRICING RULE");
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
  });

  test("confirm:true lists endpoints, activates, and lists the tenant", async () => {
    mockApi({
      "GET /tenants": { tenants: [{ ...TENANT, status: "onboarding", directoryListed: false }] },
      "GET /tenants/t-1/endpoints": { endpoints: DRAFTS },
      "PATCH /tenants/t-1/endpoints/bulk": { endpoints: [] },
      "POST /tenants/t-1/activate": { tenant: TENANT },
      "PATCH /tenants/t-1": { tenant: TENANT },
    });
    const result = await handlePublishListing({ confirm: true }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const bulkPatch = recorded.find((r) => r.method === "PATCH" && r.path.endsWith("/endpoints/bulk"))!;
    expect(bulkPatch.body).toEqual({
      endpointIds: ["ep-1", "ep-2"],
      settings: { directoryListed: true },
    });
    expect(recorded.some((r) => r.method === "POST" && r.path.endsWith("/activate"))).toBe(true);
    const tenantPatch = recorded.find((r) => r.method === "PATCH" && r.path === "/tenants/t-1")!;
    expect(tenantPatch.body).toEqual({ directoryListed: true });
    expect(result.content[0].text).toContain("Published.");
    expect(result.content[0].text).toContain("https://bolthub.ai/hub/acme");
  });

  test("unknown endpoint ids are rejected", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/endpoints": { endpoints: DRAFTS },
    });
    const result = await handlePublishListing({ endpoint_ids: ["ep-1", "nope"] }, API, TOKEN);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nope");
  });

  test("confirm:true → WALLET_REQUIRED becomes connect/deploy guidance, not a raw error", async () => {
    mockApi({
      "GET /tenants": { tenants: [{ ...TENANT, status: "onboarding", directoryListed: false }] },
      "GET /tenants/t-1/endpoints": { endpoints: DRAFTS },
      "PATCH /tenants/t-1/endpoints/bulk": WALLET_REQUIRED_400,
    });
    const result = await handlePublishListing({ confirm: true }, API, TOKEN);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("connect_wallet");
    expect(text).toContain("deploy_node");
    expect(text).not.toContain("publish_listing failed");
  });

  test("fully-live workspace is a clean no-op", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1/endpoints": {
        endpoints: DRAFTS.map((d) => ({ ...d, directoryListed: true })),
      },
    });
    const result = await handlePublishListing({ confirm: true }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Nothing to publish");
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("resolveAccountToken", () => {
  // Point the file fallback at a nonexistent path: on a machine that has
  // actually paired, ~/.bolthub/credentials.json holds a real token and
  // would leak into the "no token anywhere" case.
  beforeEach(() => {
    process.env.BOLTHUB_CREDENTIALS_PATH = "/nonexistent/bolthub-test-credentials.json";
  });
  afterEach(() => {
    delete process.env.BOLTHUB_CREDENTIALS_PATH;
  });

  test("undefined when neither name is set", () => {
    expect(resolveAccountToken({})).toBeUndefined();
  });

  test("new name wins when both are set", () => {
    expect(
      resolveAccountToken({ BOLTHUB_ACCOUNT_TOKEN: "new", BOLTHUB_AUTH_TOKEN: "old" }),
    ).toBe("new");
  });

  test("legacy BOLTHUB_AUTH_TOKEN still works as a fallback (0.4.x configs)", () => {
    expect(resolveAccountToken({ BOLTHUB_AUTH_TOKEN: "old" })).toBe("old");
  });
});

describe("sanitizeRow / pricingSuggestion", () => {
  test("drops short descriptions, truncates long fields, filters bad docsUrl", () => {
    const row = sanitizeRow({
      method: "GET",
      path: "/x",
      title: "t".repeat(300),
      description: "short",
      docsUrl: "javascript:alert(1)",
    });
    expect(row.description).toBeUndefined();
    expect(row.title!.length).toBe(255);
    expect(row.docsUrl).toBeUndefined();
    expect(row.directoryListed).toBe(false);

    const long = sanitizeRow({
      method: "GET",
      path: "/x",
      description: "d".repeat(2000),
      docsUrl: "https://docs.example.com/x",
    });
    expect(long.description!.length).toBe(1000);
    expect(long.docsUrl).toBe("https://docs.example.com/x");
  });

  test("suggests alternate models by shape, never a price", () => {
    expect(pricingSuggestion({ method: "POST", path: "/v1/generate-image" })).toContain("metered");
    expect(pricingSuggestion({ method: "GET", path: "/v1/price-stream" })).toContain("time_pass");
    expect(
      pricingSuggestion({
        method: "GET",
        path: "/v1/dump",
        exampleResponse: { rows: "r".repeat(5000) },
      }),
    ).toContain("per_kb");
    expect(pricingSuggestion({ method: "GET", path: "/v1/simple" })).toBeUndefined();
  });
});

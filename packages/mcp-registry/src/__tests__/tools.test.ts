import { describe, test, expect, mock } from "bun:test";
import { handleSearchApis, handleGetApiDetails, handlePreviewCost, handleCallApi } from "../tools";
import type { ApiClient, DirectoryEntry } from "../api-client";
import type { L402Client } from "@bolthub/agent";

function makeEntry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    slug: "test-api",
    name: "Test API",
    description: "A test API",
    tags: ["testing"],
    gatewayDomain: "gw.bolthub.ai",
    endpointCount: 1,
    endpoints: [
      {
        path: "/v1/data",
        method: "GET",
        title: "Get data",
        description: "Returns test data",
        docsUrl: null,
        pricingModel: "per_request",
        priceSats: 10,
        tokenBudget: null,
        durationMinutes: null,
        unitCostSats: null,
        freeTryEnabled: false,
        exampleRequest: null,
        exampleResponse: { data: "hello" },
      },
    ],
    ...overrides,
  };
}

function makeApiClient(entries: DirectoryEntry[] = [makeEntry()]): ApiClient {
  return {
    searchApis: mock(async () => entries),
    getApiDetails: mock(async (slug: string) => {
      const found = entries.find((e) => e.slug === slug);
      if (!found) throw new Error(`API "${slug}" not found in the bolthub directory`);
      return found;
    }),
    getGatewayUrl: (slug: string, path = "/") =>
      `https://${slug}.gw.bolthub.ai${path.startsWith("/") ? path : `/${path}`}`,
  } as any;
}

function makeL402Client(overrides: Partial<L402Client> = {}): L402Client {
  return {
    totalSpent: 0,
    remainingBudget: Infinity,
    request: mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ...overrides,
  } as any;
}

describe("handleSearchApis", () => {
  test("returns formatted listing for found APIs", async () => {
    const apiClient = makeApiClient();
    const result = await handleSearchApis({ query: "test" }, apiClient);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Test API");
    expect(result.content[0].text).toContain("test-api");
  });

  test("returns hint when no APIs found", async () => {
    const apiClient = makeApiClient([]);
    const result = await handleSearchApis({ query: "nonexistent" }, apiClient);

    expect(result.content[0].text).toContain("No APIs found");
  });

  test("returns error on API failure", async () => {
    const apiClient = makeApiClient();
    (apiClient.searchApis as any) = mock(async () => { throw new Error("Network error"); });

    const result = await handleSearchApis({}, apiClient);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network error");
  });
});

describe("handleGetApiDetails", () => {
  test("returns detailed API info", async () => {
    const apiClient = makeApiClient();
    const result = await handleGetApiDetails({ slug: "test-api" }, apiClient);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Test API");
    expect(result.content[0].text).toContain("GET /v1/data");
    expect(result.content[0].text).toContain("10 sats");
  });

  test("lists endpoint parameters when present", async () => {
    const apiClient = makeApiClient([
      makeEntry({
        endpoints: [
          {
            path: "/v1/items/{id}",
            method: "GET",
            title: null,
            description: "Item",
            docsUrl: null,
            pricingModel: "per_request",
            priceSats: 5,
            tokenBudget: null,
            durationMinutes: null,
            unitCostSats: null,
            freeTryEnabled: false,
            exampleRequest: null,
            exampleResponse: null,
            parameters: [
              { name: "id", in: "path", required: true, type: "string", description: "Item id" },
              { name: "verbose", in: "query", required: false, type: "boolean" },
            ],
          },
        ],
      }),
    ]);
    const result = await handleGetApiDetails({ slug: "test-api" }, apiClient);

    expect(result.content[0].text).toContain("Parameters:");
    expect(result.content[0].text).toContain("id [path]");
    expect(result.content[0].text).toContain("verbose [query]");
  });

  test("returns error for unknown slug", async () => {
    const apiClient = makeApiClient();
    const result = await handleGetApiDetails({ slug: "unknown" }, apiClient);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

describe("handlePreviewCost", () => {
  test("shows pricing for all endpoints", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client();
    const result = await handlePreviewCost({ slug: "test-api" }, apiClient, l402Client);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("GET /v1/data");
    expect(result.content[0].text).toContain("10 sats");
  });

  test("filters by path and method", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client();
    const result = await handlePreviewCost(
      { slug: "test-api", path: "/v1/data", method: "GET" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("GET /v1/data");
  });

  test("shows budget info when budget is set", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({ totalSpent: 50, remainingBudget: 950 } as any);
    const result = await handlePreviewCost({ slug: "test-api" }, apiClient, l402Client);

    expect(result.content[0].text).toContain("50 sats spent");
    expect(result.content[0].text).toContain("950 sats remaining");
  });
});

describe("handleCallApi", () => {
  test("calls gateway and returns response", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client();
    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"ok": true');
  });

  test("returns error on HTTP failure", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async () => new Response("bad request", { status: 400 })),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 400");
  });

  test("returns error on network failure", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async () => { throw new Error("Connection refused"); }),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Connection refused");
  });

  test("appends cost when sats are spent", async () => {
    let spent = 0;
    const apiClient = makeApiClient();
    const l402Client = {
      get totalSpent() { return spent; },
      remainingBudget: 990,
      request: mock(async () => {
        spent = 10;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    } as any as L402Client;

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.content[0].text).toContain("Cost: 10 sats");
  });

  test("sends query params", async () => {
    let capturedUrl = "";
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async (url: string) => {
        capturedUrl = url;
        return new Response("{}", { status: 200 });
      }),
    } as any);

    await handleCallApi(
      { slug: "test-api", path: "/v1/data", query_params: { city: "berlin" } },
      apiClient,
      l402Client,
    );

    expect(capturedUrl).toContain("city=berlin");
  });
});

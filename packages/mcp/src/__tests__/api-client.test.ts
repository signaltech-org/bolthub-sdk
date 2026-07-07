import { describe, test, expect, mock, afterEach } from "bun:test";
import { ApiClient } from "../sources/api-client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ApiClient", () => {
  test("searchApis sends correct query params", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ entries: [], tags: [], total: 0, hasMore: false }));
    }) as any;

    const client = new ApiClient("https://api.test.com");
    await client.searchApis("weather", "finance");

    expect(capturedUrl).toContain("/directory?");
    expect(capturedUrl).toContain("search=weather");
    expect(capturedUrl).toContain("tag=finance");
    expect(capturedUrl).toContain("limit=20");
  });

  test("searchApis returns entries", async () => {
    const entry = {
      slug: "pokemon",
      name: "Pokemon API",
      description: "Pokemon data",
      tags: ["gaming"],
      gatewayDomain: "gw.bolthub.ai",
      endpointCount: 2,
      endpoints: [],
    };

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ entries: [entry], tags: [], total: 1, hasMore: false })),
    ) as any;

    const client = new ApiClient();
    const results = await client.searchApis("pokemon");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("pokemon");
  });

  test("searchApis throws on non-OK response", async () => {
    globalThis.fetch = mock(async () =>
      new Response("server error", { status: 500 }),
    ) as any;

    const client = new ApiClient();
    await expect(client.searchApis()).rejects.toThrow("500");
  });

  test("getApiDetails fetches by slug", async () => {
    let capturedUrl = "";
    const entry = {
      slug: "weather",
      name: "Weather API",
      description: null,
      tags: [],
      gatewayDomain: "gw.bolthub.ai",
      endpointCount: 1,
      endpoints: [],
    };

    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(entry));
    }) as any;

    const client = new ApiClient("https://api.test.com");
    const result = await client.getApiDetails("weather");

    expect(capturedUrl).toContain("/directory/weather");
    expect(result.slug).toBe("weather");
  });

  test("getApiDetails throws on 404", async () => {
    globalThis.fetch = mock(async () =>
      new Response("not found", { status: 404 }),
    ) as any;

    const client = new ApiClient();
    await expect(client.getApiDetails("nonexistent")).rejects.toThrow("not found");
  });

  test("getGatewayUrl builds correct URL", () => {
    const client = new ApiClient();
    expect(client.getGatewayUrl("pokemon")).toBe("https://pokemon.gw.bolthub.ai/");
    expect(client.getGatewayUrl("pokemon", "/v2/pokemon/pikachu")).toBe(
      "https://pokemon.gw.bolthub.ai/v2/pokemon/pikachu",
    );
    expect(client.getGatewayUrl("pokemon", "v2/types")).toBe(
      "https://pokemon.gw.bolthub.ai/v2/types",
    );
  });

  test("strips trailing slashes from apiUrl", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ entries: [], tags: [], total: 0, hasMore: false }));
    }) as any;

    const client = new ApiClient("https://api.test.com///");
    await client.searchApis();
    expect(capturedUrl).toMatch(/^https:\/\/api\.test\.com\/directory/);
  });
});

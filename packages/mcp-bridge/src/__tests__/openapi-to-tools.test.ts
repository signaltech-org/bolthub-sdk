import { describe, test, expect, mock, afterEach } from "bun:test";
import {
  extractSlug,
  buildToolName,
  buildInputSchema,
  buildDescription,
  fetchOpenApiSpec,
  convertOpenApiToTools,
} from "../openapi-to-tools";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("extractSlug", () => {
  test("extracts slug from subdomain", () => {
    expect(extractSlug("https://pokemon.gw.bolthub.ai")).toBe("pokemon");
  });

  test("extracts slug from path", () => {
    expect(extractSlug("http://localhost:3001/gw/pokemon")).toBe("pokemon");
  });

  test("returns fallback for plain URL", () => {
    expect(extractSlug("https://example.com")).toBe("api");
  });
});

describe("buildToolName", () => {
  test("builds tool name from slug, method, and path", () => {
    expect(buildToolName("pokemon", "get", "/v2/pokemon")).toBe("pokemon_get_v2_pokemon");
  });
});

describe("buildInputSchema", () => {
  test("GET with query parameters", () => {
    const schema = buildInputSchema(
      {
        parameters: [
          { name: "limit", in: "query", required: true, schema: { type: "integer" }, description: "Max results" },
          { name: "offset", in: "query", schema: { type: "integer" }, description: "Starting offset" },
        ],
      },
      "get",
    );

    expect(schema.properties.limit).toEqual({ type: "integer", description: "Max results" });
    expect(schema.properties.offset).toEqual({ type: "integer", description: "Starting offset" });
    expect(schema.required).toEqual(["limit"]);
  });

  test("POST with requestBody", () => {
    const schema = buildInputSchema(
      {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } } },
            },
          },
        },
      },
      "post",
    );

    expect(schema.properties.body).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
    expect(schema.required).toContain("body");
  });

  test("empty params generates fallback query property", () => {
    const schema = buildInputSchema({}, "get");

    expect(schema.properties.query).toBeDefined();
    expect(schema.properties.query).toEqual({
      type: "string",
      description: "Optional query parameters as key=value&key2=value2",
    });
  });
});

describe("buildDescription", () => {
  test("uses summary when available", () => {
    expect(buildDescription({ summary: "List Pokemon" }, "get", "/pokemon")).toBe("List Pokemon");
  });

  test("falls back to method + path", () => {
    expect(buildDescription({}, "get", "/pokemon")).toBe("GET /pokemon");
  });

  test("appends pricing info", () => {
    const desc = buildDescription(
      { summary: "Get data", "x-l402-pricing": { model: "request", priceSats: 10 } },
      "get",
      "/data",
    );
    expect(desc).toBe("Get data (10 sats/request)");
  });
});

describe("convertOpenApiToTools", () => {
  test("converts full spec with multiple paths", () => {
    const spec = {
      info: { title: "Pokemon API" },
      paths: {
        "/v2/pokemon": {
          get: {
            summary: "List Pokemon",
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
          },
        },
        "/v2/pokemon/{id}": {
          get: { summary: "Get Pokemon" },
        },
        "/v2/abilities": {
          post: {
            summary: "Create ability",
            requestBody: {
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    };

    const tools = convertOpenApiToTools(spec, "https://pokemon.gw.bolthub.ai");

    expect(tools).toHaveLength(3);
    expect(tools[0].name).toBe("pokemon_get_v2_pokemon");
    expect(tools[0].description).toBe("List Pokemon");
    expect(tools[0].inputSchema.properties.limit).toBeDefined();
    expect(tools[0].meta.url).toBe("https://pokemon.gw.bolthub.ai/v2/pokemon");
    expect(tools[0].meta.method).toBe("GET");

    expect(tools[2].name).toBe("pokemon_post_v2_abilities");
    expect(tools[2].inputSchema.properties.body).toBeDefined();
  });

  test("returns empty array for empty paths", () => {
    const tools = convertOpenApiToTools({ paths: {} }, "https://example.com");
    expect(tools).toEqual([]);
  });

  test("returns empty array when paths is undefined", () => {
    const tools = convertOpenApiToTools({}, "https://example.com");
    expect(tools).toEqual([]);
  });
});

describe("fetchOpenApiSpec", () => {
  test("fetches and returns spec on success", async () => {
    const mockSpec = { info: { title: "Test" }, paths: {} };
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockSpec), { status: 200 }),
    ) as any;

    const spec = await fetchOpenApiSpec("https://pokemon.gw.bolthub.ai");
    expect(spec).toEqual(mockSpec);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://pokemon.gw.bolthub.ai/.well-known/openapi.json",
    );
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = mock(async () =>
      new Response("Not found", { status: 404, statusText: "Not Found" }),
    ) as any;

    try {
      await fetchOpenApiSpec("https://pokemon.gw.bolthub.ai");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("404");
    }
  });
});

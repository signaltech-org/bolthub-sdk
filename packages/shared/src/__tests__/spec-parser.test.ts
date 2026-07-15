import { describe, test, expect } from "bun:test";
import { parseFile, deduplicateEndpoints } from "../spec-parser";

// Coverage for the shared spec parser (moved from the web ApiImporter in
// GR-T2 so `@bolthub/mcp` list_api parses identically). These pin the
// behaviors the importer relies on: format detection, verb filtering,
// parameter merging, example extraction, and dedup.

const openApiSpec = {
  openapi: "3.0.0",
  info: { title: "Demo" },
  servers: [{ url: "https://api.example.com/" }],
  paths: {
    "/things/{id}": {
      parameters: [
        { name: "id", in: "path", schema: { type: "string", example: "abc" } },
      ],
      get: {
        summary: "Get a thing",
        description: "Fetches one thing by id.",
        parameters: [
          {
            name: "verbose",
            in: "query",
            schema: { type: "boolean", examples: [true] },
          },
        ],
        responses: {
          "200": {
            content: { "application/json": { example: { id: "abc" } } },
          },
        },
      },
      delete: { summary: "Remove a thing" },
    },
    "/compute": {
      post: {
        operationId: "runCompute",
        requestBody: {
          content: { "application/json": { example: { input: 1 } } },
        },
        responses: {},
      },
    },
  },
};

describe("parseFile — OpenAPI", () => {
  test("parses endpoints, keeps GET/POST/HEAD, skips mutating verbs", () => {
    const result = parseFile(JSON.stringify(openApiSpec), "spec.json");
    expect(result?.format).toBe("openapi");
    const methods = result!.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(methods).toContain("GET /things/{id}");
    expect(methods).toContain("POST /compute");
    expect(methods).not.toContain("DELETE /things/{id}");
  });

  test("strips trailing slash from server URL and sets originUrl", () => {
    const result = parseFile(JSON.stringify(openApiSpec), "spec.json");
    expect(result!.endpoints[0].originUrl).toBe("https://api.example.com");
  });

  test("merges path-level and operation-level parameters, path params required", () => {
    const result = parseFile(JSON.stringify(openApiSpec), "spec.json");
    const get = result!.endpoints.find((e) => e.method === "GET")!;
    const byName = Object.fromEntries(get.parameters!.map((p) => [p.name, p]));
    expect(byName.id.in).toBe("path");
    expect(byName.id.required).toBe(true);
    expect(byName.id.example).toBe("abc");
    // 3.1-style schema.examples ARRAY is read for a value
    expect(byName.verbose.example).toBe(true);
  });

  test("title from summary/operationId without echoing into description", () => {
    const result = parseFile(JSON.stringify(openApiSpec), "spec.json");
    const get = result!.endpoints.find((e) => e.method === "GET")!;
    expect(get.title).toBe("Get a thing");
    expect(get.description).toBe("Fetches one thing by id.");
    const post = result!.endpoints.find((e) => e.method === "POST")!;
    expect(post.title).toBe("runCompute");
    expect(post.description).toBe("");
  });

  test("extracts request/response examples from content blocks", () => {
    const result = parseFile(JSON.stringify(openApiSpec), "spec.json");
    const get = result!.endpoints.find((e) => e.method === "GET")!;
    expect(get.exampleResponse).toEqual({ id: "abc" });
    const post = result!.endpoints.find((e) => e.method === "POST")!;
    expect(post.exampleRequest).toEqual({ input: 1 });
  });

  test("parses YAML when the filename says so", () => {
    const yamlSpec = [
      "openapi: 3.0.0",
      "paths:",
      "  /ping:",
      "    get:",
      "      summary: Ping",
    ].join("\n");
    const result = parseFile(yamlSpec, "spec.yaml");
    expect(result?.format).toBe("openapi");
    expect(result!.endpoints[0].path).toBe("/ping");
  });
});

describe("parseFile — Postman", () => {
  const collection = {
    info: { _postman_id: "x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/" },
    variable: [{ key: "baseUrl", value: "https://pm.example.com", description: "API host" }],
    item: [
      {
        name: "Folder",
        item: [
          {
            name: "Get widget",
            request: {
              method: "GET",
              description: "Reads one widget.",
              url: {
                raw: "{{baseUrl}}/widgets/:widgetId?verbose=true",
                host: ["{{baseUrl}}"],
                path: ["widgets", ":widgetId"],
                query: [{ key: "verbose", value: "true", description: "More fields" }],
                variable: [{ key: "widgetId", value: "w1" }],
              },
              header: [
                { key: "Authorization", value: "Bearer x" },
                { key: "X-Custom", value: "1" },
              ],
            },
            response: [{ code: 200, body: '{"id":"w1"}' }],
          },
        ],
      },
    ],
  };

  test("walks nested items, normalizes :params, keeps custom headers only", () => {
    const result = parseFile(JSON.stringify(collection), "collection.json");
    expect(result?.format).toBe("postman");
    const ep = result!.endpoints[0];
    expect(ep.method).toBe("GET");
    expect(ep.path).toBe("/widgets/{widgetId}");
    expect(ep.title).toBe("Get widget");
    expect(ep.description).toBe("Reads one widget.");
    const names = ep.parameters!.map((p) => `${p.in}:${p.name}`);
    expect(names).toContain("query:verbose");
    expect(names).toContain("path:widgetId");
    expect(names).toContain("header:X-Custom");
    expect(names).not.toContain("header:Authorization");
  });

  test("takes the 2xx saved response as exampleResponse", () => {
    const result = parseFile(JSON.stringify(collection), "collection.json");
    expect(result!.endpoints[0].exampleResponse).toEqual({ id: "w1" });
  });
});

describe("parseFile — plain JSON array + rejects", () => {
  test("parses a bare endpoint array", () => {
    const arr = [
      { method: "get", path: "/a", title: "A", url: "https://x.example.com" },
      { method: "POST", path: "/b" },
    ];
    const result = parseFile(JSON.stringify(arr), "endpoints.json");
    expect(result?.format).toBe("json");
    expect(result!.endpoints[0].method).toBe("GET");
    expect(result!.endpoints[0].originUrl).toBe("https://x.example.com");
    expect(result!.endpoints).toHaveLength(2);
  });

  test("returns null for unrecognized or unparseable content", () => {
    expect(parseFile("{\"hello\":true}", "x.json")).toBeNull();
    expect(parseFile("not json at all", "x.json")).toBeNull();
    expect(parseFile(": not yaml [", "x.yaml")).toBeNull();
  });
});

describe("deduplicateEndpoints", () => {
  test("merges duplicate method+path rows, unioning parameters", () => {
    const { endpoints, mergedCount } = deduplicateEndpoints([
      { method: "GET", path: "/a", title: "", parameters: [{ name: "q", in: "query" }] },
      { method: "GET", path: "/a", title: "Kept", parameters: [{ name: "r", in: "query" }] },
      { method: "POST", path: "/a" },
    ]);
    expect(mergedCount).toBe(1);
    expect(endpoints).toHaveLength(2);
    const merged = endpoints[0];
    expect(merged.title).toBe("Kept");
    expect(merged.parameters!.map((p) => p.name).sort()).toEqual(["q", "r"]);
  });
});

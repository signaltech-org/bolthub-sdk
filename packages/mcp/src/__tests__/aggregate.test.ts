import { describe, expect, test } from "bun:test";
import { buildAggregate } from "../aggregate";
import type { SourceTool, ToolSource } from "../sources/source";

function fakeSource(
  key: string,
  tools: SourceTool[],
  opts: { namespaced?: boolean; kind?: ToolSource["kind"] } = {},
): ToolSource {
  return {
    key,
    kind: opts.kind ?? "mcp",
    namespaced: opts.namespaced ?? true,
    init: async () => {},
    listTools: () => tools,
    callTool: async (name) => ({ content: [{ type: "text", text: `${key}:${name}` }] }),
    close: async () => {},
  };
}

const search: SourceTool = { name: "search", inputSchema: { type: "object", properties: {} } };

describe("buildAggregate — prefix mode", () => {
  test("namespaces per source key; same tool name on two sources routes to each", async () => {
    const a = fakeSource("a", [search]);
    const b = fakeSource("b", [search]);
    const agg = buildAggregate([a, b], "prefix");

    expect(agg.tools.map((t) => t.publicName).sort()).toEqual(["a__search", "b__search"]);
    const viaA = await agg.route.get("a__search")!.source.callTool("search", {});
    const viaB = await agg.route.get("b__search")!.source.callTool("search", {});
    expect(viaA.content[0].text).toBe("a:search");
    expect(viaB.content[0].text).toBe("b:search");
  });

  test("non-namespaced sources (marketplace) stay bare and cannot collide with prefixed names", () => {
    const marketplace = fakeSource("marketplace", [{ name: "search_apis", inputSchema: { type: "object" } }], {
      namespaced: false,
      kind: "marketplace",
    });
    const gw = fakeSource("search_apis", [{ name: "x", inputSchema: { type: "object" } }]);
    const agg = buildAggregate([marketplace, gw], "prefix");
    expect(agg.tools.map((t) => t.publicName).sort()).toEqual(["search_apis", "search_apis__x"]);
  });

  test("two sources with the SAME key collide loudly", () => {
    const a1 = fakeSource("api", [search]);
    const a2 = fakeSource("api", [search]);
    expect(() => buildAggregate([a1, a2], "prefix")).toThrow(/collision.*"api__search"/);
  });

  test("inputSchema passes through byte-for-byte (no zod round-trip)", () => {
    const schema = {
      type: "object",
      properties: {
        nested: { type: "object", properties: { deep: { type: "array", items: { type: "number" } } } },
      },
      required: ["nested"],
      additionalProperties: false,
      $defs: { custom: { type: "string", pattern: "^x" } },
    };
    const src = fakeSource("s", [{ name: "t", inputSchema: schema }]);
    const agg = buildAggregate([src], "prefix");
    expect(agg.tools[0].inputSchema).toBe(schema); // same reference — untouched
  });
});

describe("buildAggregate — flat mode", () => {
  test("names pass through bare", () => {
    const a = fakeSource("a", [search]);
    const agg = buildAggregate([a], "flat");
    expect(agg.tools[0].publicName).toBe("search");
  });

  test("any collision is a startup error naming both owners", () => {
    const a = fakeSource("a", [search]);
    const b = fakeSource("b", [search]);
    expect(() => buildAggregate([a, b], "flat")).toThrow(/"a".*"b"|both/);
  });

  test("collision with a marketplace meta-tool is also fatal", () => {
    const marketplace = fakeSource("marketplace", [{ name: "call_api", inputSchema: { type: "object" } }], {
      namespaced: false,
      kind: "marketplace",
    });
    const rogue = fakeSource("rogue", [{ name: "call_api", inputSchema: { type: "object" } }]);
    expect(() => buildAggregate([marketplace, rogue], "flat")).toThrow(/collision/);
  });
});

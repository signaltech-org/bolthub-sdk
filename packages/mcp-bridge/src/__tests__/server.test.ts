import { describe, test, expect } from "bun:test";
import { jsonSchemaToZod, buildZodShape } from "../server";
import type { McpToolDefinition } from "../openapi-to-tools";

describe("jsonSchemaToZod", () => {
  test("converts each JSON Schema type to the correct Zod type", () => {
    const stringZ = jsonSchemaToZod({ type: "string", description: "A name" });
    expect(stringZ.safeParse("hello").success).toBe(true);
    expect(stringZ.safeParse(42).success).toBe(false);

    const numberZ = jsonSchemaToZod({ type: "number" });
    expect(numberZ.safeParse(42).success).toBe(true);
    expect(numberZ.safeParse("nope").success).toBe(false);

    const intZ = jsonSchemaToZod({ type: "integer" });
    expect(intZ.safeParse(42).success).toBe(true);

    const boolZ = jsonSchemaToZod({ type: "boolean" });
    expect(boolZ.safeParse(true).success).toBe(true);
    expect(boolZ.safeParse("yes").success).toBe(false);

    const objZ = jsonSchemaToZod({ type: "object" });
    expect(objZ.safeParse({ key: "value" }).success).toBe(true);

    const arrZ = jsonSchemaToZod({ type: "array" });
    expect(arrZ.safeParse([1, 2, 3]).success).toBe(true);

    const unknownZ = jsonSchemaToZod({});
    expect(unknownZ.safeParse("anything").success).toBe(true);
    expect(unknownZ.safeParse(undefined).success).toBe(true);
  });
});

describe("buildZodShape", () => {
  test("marks required fields as non-optional and optional fields as optional", () => {
    const tool: McpToolDefinition = {
      name: "test_tool",
      description: "test",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Required name" },
          limit: { type: "integer", description: "Optional limit" },
        },
        required: ["name"],
      },
      meta: { url: "https://example.com", method: "GET", path: "/" },
    };

    const shape = buildZodShape(tool);

    expect(shape.name.safeParse("hello").success).toBe(true);
    expect(shape.name.safeParse(undefined).success).toBe(false);

    expect(shape.limit.safeParse(10).success).toBe(true);
    expect(shape.limit.safeParse(undefined).success).toBe(true);
  });
});

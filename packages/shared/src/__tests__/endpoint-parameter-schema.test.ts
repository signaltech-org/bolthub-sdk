import { describe, expect, test } from "bun:test";
import { buildMcpToolInputSchema } from "../endpoint-parameter-schema";

describe("buildMcpToolInputSchema", () => {
  test("uses generic query when nothing else is known (GET)", () => {
    const s = buildMcpToolInputSchema(null, "GET", null);
    expect(s.properties.query).toEqual({
      type: "string",
      description: "Query parameters as key=value&key2=value2",
    });
  });

  test("adds body and generic query for POST with no metadata", () => {
    const s = buildMcpToolInputSchema(null, "POST", null);
    expect(s.properties.body).toBeDefined();
    expect(s.properties.query).toBeDefined();
  });

  test("lists path and query from parameters", () => {
    const s = buildMcpToolInputSchema(
      [
        { name: "exchange_name", in: "path", type: "string", description: "Exchange", required: true },
        { name: "interval", in: "query", type: "string", description: "Candle interval" },
      ],
      "GET",
      null,
    );
    expect(s.properties.exchange_name).toBeDefined();
    expect(s.properties.interval).toBeDefined();
    expect(s.properties.query).toBeUndefined();
    expect(s.required).toContain("exchange_name");
  });

  test("infers keys from example when parameters empty", () => {
    const s = buildMcpToolInputSchema(null, "GET", {
      path_parameters: { symbol: "BTCUSDT", exchange_name: "bybit" },
      query_parameters: { interval: "1" },
    });
    expect(s.properties.symbol).toBeDefined();
    expect(s.properties.exchange_name).toBeDefined();
    expect(s.properties.interval).toBeDefined();
    expect(s.properties.query).toBeUndefined();
  });
});

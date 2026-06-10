import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import { formatPricing, search, info, createWallet } from "../index";

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...args: any[]) => { logs.push(args.join(" ")); };
  console.error = (...args: any[]) => { errors.push(args.join(" ")); };
  process.exit = mock(() => { throw new Error("process.exit called"); }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;

  delete process.env.LND_REST_HOST;
  delete process.env.LND_MACAROON;
  delete process.env.LNBITS_URL;
  delete process.env.LNBITS_ADMIN_KEY;
  delete process.env.PHOENIXD_URL;
  delete process.env.PHOENIXD_PASSWORD;
  delete process.env.NWC_URI;
});

describe("formatPricing", () => {
  test("returns 'free' when priceSats is null", () => {
    expect(formatPricing({
      path: "/", method: "GET", title: null, description: null,
      pricingModel: null, priceSats: null, tokenBudget: null,
      durationMinutes: null, unitCostSats: null, freeTryEnabled: false,
    })).toBe("free");
  });

  test("formats per_request pricing", () => {
    expect(formatPricing({
      path: "/", method: "GET", title: null, description: null,
      pricingModel: "per_request", priceSats: 10, tokenBudget: null,
      durationMinutes: null, unitCostSats: null, freeTryEnabled: false,
    })).toBe("10 sats/request");
  });

  test("formats token_bucket pricing", () => {
    expect(formatPricing({
      path: "/", method: "GET", title: null, description: null,
      pricingModel: "token_bucket", priceSats: 100, tokenBudget: 50,
      durationMinutes: null, unitCostSats: null, freeTryEnabled: false,
    })).toBe("100 sats for 50 requests");
  });

  test("formats time_pass pricing", () => {
    expect(formatPricing({
      path: "/", method: "GET", title: null, description: null,
      pricingModel: "time_pass", priceSats: 200, tokenBudget: null,
      durationMinutes: 60, unitCostSats: null, freeTryEnabled: false,
    })).toBe("200 sats for 60 min");
  });

  test("formats per_kb pricing", () => {
    expect(formatPricing({
      path: "/", method: "GET", title: null, description: null,
      pricingModel: "per_kb", priceSats: 50, tokenBudget: null,
      durationMinutes: null, unitCostSats: 5, freeTryEnabled: false,
    })).toBe("5 sats/KB (50 deposit)");
  });

  test("formats metered pricing", () => {
    expect(formatPricing({
      path: "/", method: "GET", title: null, description: null,
      pricingModel: "metered", priceSats: 100, tokenBudget: null,
      durationMinutes: null, unitCostSats: 3, freeTryEnabled: false,
    })).toBe("100 deposit, 3 sats/req");
  });
});

describe("search", () => {
  test("displays results", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        entries: [{
          slug: "pokemon",
          name: "Pokemon API",
          description: "Pokemon data",
          tags: ["gaming"],
          gatewayDomain: "gw.bolthub.ai",
          endpointCount: 2,
          endpoints: [{ priceSats: 10 }],
        }],
        total: 1,
        hasMore: false,
      })),
    ) as any;

    await search("pokemon");
    const output = logs.join("\n");
    expect(output).toContain("Pokemon API");
    expect(output).toContain("pokemon");
  });

  test("handles empty results", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ entries: [], total: 0, hasMore: false })),
    ) as any;

    await search("nonexistent");
    expect(logs.join("\n")).toContain("No APIs found");
  });
});

describe("info", () => {
  test("displays API details", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        slug: "weather",
        name: "Weather API",
        description: "Get weather data",
        tags: ["weather"],
        gatewayDomain: "weather.gw.bolthub.ai",
        endpointCount: 1,
        endpoints: [{
          path: "/v1/current",
          method: "GET",
          title: "Current weather",
          description: null,
          pricingModel: "per_request",
          priceSats: 5,
          tokenBudget: null,
          durationMinutes: null,
          unitCostSats: null,
          freeTryEnabled: true,
        }],
      })),
    ) as any;

    await info("weather");
    const output = logs.join("\n");
    expect(output).toContain("Weather API");
    expect(output).toContain("GET /v1/current");
    expect(output).toContain("5 sats");
    expect(output).toContain("Free try: available");
  });

  test("exits on 404", async () => {
    globalThis.fetch = mock(async () =>
      new Response("not found", { status: 404 }),
    ) as any;

    try {
      await info("nonexistent");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(errors.join("\n")).toContain("not found");
  });
});

describe("createWallet", () => {
  test("creates LND wallet from env", async () => {
    process.env.LND_REST_HOST = "https://lnd.example.com";
    process.env.LND_MACAROON = "deadbeef";

    const wallet = await createWallet();
    expect(wallet).toBeDefined();
    expect(wallet.payInvoice).toBeDefined();
  });

  test("creates LNbits wallet from env", async () => {
    process.env.LNBITS_URL = "https://lnbits.example.com";
    process.env.LNBITS_ADMIN_KEY = "key123";

    const wallet = await createWallet();
    expect(wallet).toBeDefined();
  });

  test("creates Phoenixd wallet from env", async () => {
    process.env.PHOENIXD_URL = "http://localhost:9740";
    process.env.PHOENIXD_PASSWORD = "pass";

    const wallet = await createWallet();
    expect(wallet).toBeDefined();
  });

  test("exits when no wallet configured", async () => {
    try {
      await createWallet();
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }
    expect(errors.join("\n")).toContain("No wallet configured");
  });
});

import { describe, test, expect, mock, afterEach } from "bun:test";
import { executeToolCall, pathPlaceholderNames } from "../tool-handler";
import { L402Client } from "@bolthub/agent";
import type { WalletAdapter } from "@bolthub/agent";
import type { McpToolDefinition } from "../openapi-to-tools";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createTool(overrides?: Partial<McpToolDefinition["meta"]>): McpToolDefinition {
  return {
    name: "test_get_data",
    description: "Test endpoint",
    inputSchema: { type: "object", properties: {} },
    meta: {
      url: "https://api.example.com/data",
      method: "GET",
      path: "/data",
      ...overrides,
    },
  };
}

function createMockClient(preimage = "abc123") {
  const wallet: WalletAdapter = { payInvoice: mock(async () => ({ preimage })) };
  return { client: new L402Client({ wallet }), wallet };
}

describe("executeToolCall", () => {
  test("returns formatted JSON on 200 response", async () => {
    const { client, wallet } = createMockClient();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ pokemon: "pikachu" }), { status: 200 }),
    ) as any;

    const result = await executeToolCall(createTool(), {}, client);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ pokemon: "pikachu" });
    expect(wallet.payInvoice).not.toHaveBeenCalled();
  });

  test("handles 402 -> pay -> retry flow", async () => {
    const { client, wallet } = createMockClient("preimage_paid");
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "pay" }), {
          status: 402,
          headers: { "WWW-Authenticate": 'L402 macaroon="mac1", invoice="lnbc1000..."' },
        });
      }
      return new Response(JSON.stringify({ data: "paid content" }), { status: 200 });
    }) as any;

    const result = await executeToolCall(createTool(), {}, client);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ data: "paid content" });
    expect(wallet.payInvoice).toHaveBeenCalledWith("lnbc1000...");
  });

  test("returns error when 402 has no challenge", async () => {
    const { client } = createMockClient();
    globalThis.fetch = mock(async () =>
      new Response("", { status: 402 }),
    ) as any;

    const result = await executeToolCall(createTool(), {}, client);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("L402");
  });

  test("returns error on non-200 response", async () => {
    const { client } = createMockClient();
    globalThis.fetch = mock(async () =>
      new Response("Internal Server Error", { status: 500 }),
    ) as any;

    const result = await executeToolCall(createTool(), {}, client);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("500");
  });

  test("returns plain text for non-JSON responses", async () => {
    const { client } = createMockClient();
    globalThis.fetch = mock(async () =>
      new Response("Hello, world!", { status: 200 }),
    ) as any;

    const result = await executeToolCall(createTool(), {}, client);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Hello, world!");
  });

  test("forwards query params in URL", async () => {
    const { client } = createMockClient();
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as any;

    await executeToolCall(createTool(), { limit: "10", offset: "5" }, client);

    expect(capturedUrl).toContain("limit=10");
    expect(capturedUrl).toContain("offset=5");
  });

  test("substitutes path placeholders and does not duplicate them in query", async () => {
    const { client } = createMockClient();
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as any;

    const tool = createTool({
      url: "https://api.example.com/exchange/{exchange_name}/ticker/{symbol}",
      path: "/exchange/{exchange_name}/ticker/{symbol}",
    });
    await executeToolCall(
      tool,
      { exchange_name: "bybit", symbol: "BTCUSDT", interval: "1" },
      client,
    );

    expect(capturedUrl).toContain("/exchange/bybit/ticker/BTCUSDT");
    expect(capturedUrl).toContain("interval=1");
    expect(capturedUrl).not.toContain("exchange_name=");
    expect(capturedUrl).not.toContain("symbol=");
  });

  test("returns error when path placeholder is missing", async () => {
    const { client } = createMockClient();
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as any;

    const tool = createTool({
      url: "https://api.example.com/items/{id}",
      path: "/items/{id}",
    });
    const result = await executeToolCall(tool, { limit: "1" }, client);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing path parameter "id"');
  });

  test("pathPlaceholderNames extracts ordered segments", () => {
    expect(pathPlaceholderNames("https://x/a/{foo}/b/{bar}")).toEqual(["foo", "bar"]);
    expect(pathPlaceholderNames("https://x/static")).toEqual([]);
  });

  test("forwards POST body with Content-Type header", async () => {
    const { client } = createMockClient();
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as any;

    const tool = createTool({ method: "POST" });
    await executeToolCall(tool, { body: { name: "pikachu" } }, client);

    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(capturedInit?.body).toBe(JSON.stringify({ name: "pikachu" }));
  });

  test("returns error on network failure", async () => {
    const { client } = createMockClient();
    globalThis.fetch = mock(async () => {
      throw new Error("Network unreachable");
    }) as any;

    const result = await executeToolCall(createTool(), {}, client);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network unreachable");
  });
});

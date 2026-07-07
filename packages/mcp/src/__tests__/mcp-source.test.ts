/**
 * The downstream-MCP source, driven through the REAL SDK end to end:
 *
 *   upstream Client ⇄ unified Server ⇄ McpServerSource ⇄ downstream McpServer
 *
 * over linked in-memory transports — no child processes, no real Lightning.
 * Covers DESIGN.md's verification scenarios: free passthrough, paid happy
 * path, budget gate, namespacing/routing, flat-mode collision, pagination.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Budget,
  ToolClient,
  createPaywall,
  l402Payer,
  l402Rail,
  randomPreimage,
  sha256Hex,
} from "@bolthub/pay";
import type { InvoiceProvider, ToolHandler } from "@bolthub/pay";
import { McpServerSource } from "../sources/mcp";
import type { DownstreamClient } from "../sources/mcp";
import { buildAggregate } from "../aggregate";
import { createUnifiedServer } from "../server";
import type { PaymentServices } from "../payment";

const SECRET = "test-secret-at-least-thirty-two-bytes-long!!";

class MockLightning {
  private byInvoice = new Map<string, string>();
  invoiceProvider: InvoiceProvider = {
    createInvoice: async (amountSat) => {
      const preimage = randomPreimage();
      const paymentHash = sha256Hex(preimage);
      const invoice = `lnbcmock${amountSat}_${paymentHash.slice(0, 8)}`;
      this.byInvoice.set(invoice, preimage);
      return { invoice, paymentHash };
    },
  };
  wallet = {
    payInvoice: async (bolt11: string) => {
      const preimage = this.byInvoice.get(bolt11);
      if (!preimage) throw new Error("unknown invoice");
      return { preimage };
    },
  };
}

type RegisterTools = (server: McpServer) => void;

/** Downstream McpServer connected to an SDK Client over linked transports. */
async function downstream(register: RegisterTools): Promise<Client> {
  const server = new McpServer({ name: "downstream", version: "0.0.0" });
  register(server);
  const client = new Client({ name: "proxy-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function freeTool(name: string, text: string): RegisterTools {
  return (server) =>
    server.registerTool(name, { description: `free ${name}`, inputSchema: {} }, (async () => ({
      content: [{ type: "text", text }],
    })) as never);
}

function paidTool(name: string, ln: MockLightning, priceSat: number): RegisterTools {
  const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: ln.invoiceProvider })] });
  const handler: ToolHandler = pay({ price: { amount: priceSat }, resource: name }, async () => ({
    content: [{ type: "text", text: `PAID:${name}` }],
  }));
  return (server) =>
    server.registerTool(name, { description: `paid ${name}`, inputSchema: {} }, ((
      args: Record<string, unknown>,
      extra: { _meta?: Record<string, unknown> },
    ) => handler(args, extra)) as never);
}

function services(ln: MockLightning, limits: ConstructorParameters<typeof Budget>[0] = {}): PaymentServices {
  const budget = new Budget(limits);
  return {
    budget,
    toolClient: new ToolClient({ payers: [l402Payer({ wallet: ln.wallet })], budget }),
  } as PaymentServices;
}

async function sourceFor(
  key: string,
  client: Client | DownstreamClient,
  svc: PaymentServices,
): Promise<McpServerSource> {
  const source = new McpServerSource(
    key,
    { command: "unused-in-tests" },
    svc,
    async () => client as DownstreamClient,
  );
  await source.init();
  return source;
}

/** Wire aggregated sources into a unified Server and hand back an upstream Client. */
async function upstreamFor(sources: McpServerSource[], namespace: "prefix" | "flat" = "prefix") {
  const aggregate = buildAggregate(sources, namespace);
  const server = createUnifiedServer(aggregate, { version: "0.0.0" });
  const client = new Client({ name: "upstream-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

describe("McpServerSource through the unified server", () => {
  test("free tools pass through untouched; nothing is spent", async () => {
    const ln = new MockLightning();
    const svc = services(ln, { maxTotal: { sat: 100 } });
    const src = await sourceFor("fs", await downstream(freeTool("read_file", "FILE CONTENTS")), svc);
    const upstream = await upstreamFor([src]);

    const tools = await upstream.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["fs__read_file"]);

    const result = (await upstream.callTool({ name: "fs__read_file", arguments: {} })) as TextResult;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("FILE CONTENTS");
    expect(svc.budget.spentFor("sat")).toBe(0);
  });

  test("paid happy path: challenge → pay → retry, spend recorded", async () => {
    const ln = new MockLightning();
    const svc = services(ln, { maxTotal: { sat: 100 } });
    const src = await sourceFor("intel", await downstream(paidTool("summary", ln, 7)), svc);
    const upstream = await upstreamFor([src]);

    const result = (await upstream.callTool({ name: "intel__summary", arguments: {} })) as TextResult;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("PAID:summary");
    expect(svc.budget.spentFor("sat")).toBe(7);
  });

  test("budget gate: an unaffordable offer returns a clean 'Payment refused' result and pays nothing", async () => {
    const ln = new MockLightning();
    let walletCalls = 0;
    const originalPay = ln.wallet.payInvoice;
    ln.wallet.payInvoice = async (b: string) => {
      walletCalls++;
      return originalPay(b);
    };
    const svc = services(ln, { maxPerCall: { sat: 3 } });
    const src = await sourceFor("intel", await downstream(paidTool("summary", ln, 7)), svc);
    const upstream = await upstreamFor([src]);

    const result = (await upstream.callTool({ name: "intel__summary", arguments: {} })) as TextResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Payment refused");
    expect(walletCalls).toBe(0);
    expect(svc.budget.spentFor("sat")).toBe(0);
  });

  test("no wallet: free tools work, paid tools surface the challenge", async () => {
    const ln = new MockLightning();
    const svc = { budget: new Budget() } as PaymentServices; // wallet-less
    const src = await sourceFor(
      "mixed",
      await downstream((server) => {
        freeTool("free_thing", "OK")(server);
        paidTool("paid_thing", ln, 5)(server);
      }),
      svc,
    );
    const upstream = await upstreamFor([src]);

    const free = (await upstream.callTool({ name: "mixed__free_thing", arguments: {} })) as TextResult;
    expect(free.content[0].text).toBe("OK");

    const paid = (await upstream.callTool({ name: "mixed__paid_thing", arguments: {} })) as TextResult;
    expect(paid.isError).toBe(true); // the paywall challenge, forwarded as-is
    expect(JSON.stringify(paid)).toContain("payment_required");
  });

  test("namespacing: two downstreams exposing the same tool route independently", async () => {
    const ln = new MockLightning();
    const svc = services(ln);
    const a = await sourceFor("a", await downstream(freeTool("search", "FROM A")), svc);
    const b = await sourceFor("b", await downstream(freeTool("search", "FROM B")), svc);
    const upstream = await upstreamFor([a, b]);

    const names = (await upstream.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["a__search", "b__search"]);
    expect(((await upstream.callTool({ name: "a__search", arguments: {} })) as TextResult).content[0].text).toBe("FROM A");
    expect(((await upstream.callTool({ name: "b__search", arguments: {} })) as TextResult).content[0].text).toBe("FROM B");
  });

  test("flat mode with a collision throws at startup", async () => {
    const ln = new MockLightning();
    const svc = services(ln);
    const a = await sourceFor("a", await downstream(freeTool("search", "FROM A")), svc);
    const b = await sourceFor("b", await downstream(freeTool("search", "FROM B")), svc);
    expect(() => buildAggregate([a, b], "flat")).toThrow(/collision/);
  });

  test("listTools pagination: tools across nextCursor pages all arrive", async () => {
    const pageOne = [{ name: "one", inputSchema: { type: "object" } }];
    const pageTwo = [{ name: "two", inputSchema: { type: "object" } }];
    const stub: DownstreamClient = {
      listTools: async (params) =>
        params?.cursor === "p2" ? { tools: pageTwo } : { tools: pageOne, nextCursor: "p2" },
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    };
    const svc = { budget: new Budget() } as PaymentServices;
    const src = await sourceFor("paged", stub, svc);
    expect(src.listTools().map((t) => t.name)).toEqual(["one", "two"]);
  });
});

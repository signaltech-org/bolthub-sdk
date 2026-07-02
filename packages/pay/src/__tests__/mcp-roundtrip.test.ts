/**
 * Blocker #1: does the TPP `_meta` envelope survive a REAL MCP SDK round-trip?
 *
 * The whole MCP profile assumes (a) a challenge in a tool result's `_meta`
 * reaches the client, and (b) a proof in the request `params._meta` reaches the
 * handler as `extra._meta`. Everything else was tested against a fake transport;
 * this drives the actual `@modelcontextprotocol/sdk` client ↔ server over a
 * linked in-memory transport, so if the SDK's zod schemas strip our custom
 * `ai.bolthub/payment` key, these tests fail.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PayingClient, getPaymentChallenge } from "../buyer/client";
import { createPaywall } from "../paywall";
import { l402Payer } from "../payers/l402";
import { l402Rail } from "../rails/l402";
import { randomPreimage, sha256Hex } from "../token";
import type { InvoiceProvider, McpCallToolClient, ToolHandler, ToolResult } from "../types";

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

/** Stand up a real MCP server + client over a linked in-memory transport. Tools
 *  must be registered (via `setup`) BEFORE connecting — the SDK locks
 *  capabilities at connect time. */
async function connectedPair(setup: (server: McpServer) => void) {
  const server = new McpServer({ name: "btc-intel-test", version: "0.0.0" });
  setup(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/** Register a paywalled tool on the real server. The `as never` casts bridge our
 *  structural `ToolResult`/`ToolHandler` to the SDK's stricter `CallToolResult`/
 *  `ToolCallback` — a pre-publish type-alignment item, not a runtime concern. */
function registerPaidTool(server: McpServer, handler: ToolHandler) {
  server.registerTool(
    "btc_history_summary",
    { description: "Premium BTC market summary", inputSchema: {} },
    ((args: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => handler(args, extra)) as never,
  );
}

/** Adapt the SDK client to the buyer client's minimal interface. */
function asPayClient(client: Client): McpCallToolClient {
  return { callTool: (params) => client.callTool(params) };
}

describe("real MCP SDK round-trip", () => {
  test("an unpaid call surfaces the challenge to the client (result _meta survives server→client)", async () => {
    const ln = new MockLightning();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: ln.invoiceProvider })] });
    const { client } = await connectedPair((server) =>
      registerPaidTool(server, pay({ price: { amount: 5 }, resource: "btc_history_summary" }, async () => ({
        content: [{ type: "text", text: "BTC PREMIUM DATA" }],
      }))),
    );

    // `arguments: {}` is required — the SDK validates inputs before the handler.
    const raw = (await client.callTool({ name: "btc_history_summary", arguments: {} })) as ToolResult;

    expect(raw.isError).toBe(true);
    const challenge = getPaymentChallenge(raw);
    expect(challenge?.resource).toBe("btc_history_summary");
    expect(challenge?.offers[0].scheme).toBe("l402");
    expect(challenge?.offers[0].invoice).toBeDefined();
  });

  test("PayingClient pays and the proof reaches the handler (request _meta survives client→server)", async () => {
    const ln = new MockLightning();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: ln.invoiceProvider })] });
    const { client } = await connectedPair((server) =>
      registerPaidTool(server, pay({ price: { amount: 5 }, resource: "btc_history_summary" }, async () => ({
        content: [{ type: "text", text: "BTC PREMIUM DATA" }],
      }))),
    );

    const buyer = new PayingClient({ payers: [l402Payer({ wallet: ln.wallet })], maxTotal: { sat: 100 } });
    const result = await buyer.callTool(asPayClient(client), "btc_history_summary");

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("BTC PREMIUM DATA");
    expect(buyer.spentFor("sat")).toBe(5);
  });

  test("a wrong proof is rejected end to end (no unlock)", async () => {
    const ln = new MockLightning();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: ln.invoiceProvider })] });
    const { client } = await connectedPair((server) =>
      registerPaidTool(server, pay({ price: { amount: 5 }, resource: "btc_history_summary" }, async () => ({
        content: [{ type: "text", text: "BTC PREMIUM DATA" }],
      }))),
    );

    // Grab a real challenge, then present a bogus preimage.
    const challenge = getPaymentChallenge(
      (await client.callTool({ name: "btc_history_summary", arguments: {} })) as ToolResult,
    )!;
    const token = challenge.offers[0].token as string;
    const bad = (await client.callTool({
      name: "btc_history_summary",
      arguments: {},
      _meta: { "ai.bolthub/payment": { scheme: "l402", proof: `${token}:${randomPreimage()}` } },
    })) as ToolResult;

    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).not.toContain("BTC PREMIUM DATA");
  });
});

/**
 * THE headline property of the unified server: one `Budget`, two payment
 * paths. Gateway/marketplace tools spend via `L402Client` (HTTP 402);
 * downstream MCP tools spend via `ToolClient` (TPP `_meta` challenge) —
 * and neither can take the pool past `maxTotal`, in either order.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Budget,
  L402BudgetError,
  L402Client,
  PaymentBudgetError,
  ToolClient,
  createPaywall,
  l402Payer,
  l402Rail,
  randomPreimage,
  sha256Hex,
} from "@bolthub/pay";
import type { InvoiceProvider, ToolHandler, WalletAdapter } from "@bolthub/pay";

const SECRET = "test-secret-at-least-thirty-two-bytes-long!!";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Pays TPP mock invoices exactly (preimage must hash-match) and any other
 *  BOLT11 blindly — one wallet serving both payment paths, like production. */
class HybridWallet implements WalletAdapter {
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
  failNext = false;
  async payInvoice(bolt11: string): Promise<{ preimage: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated wallet failure");
    }
    return { preimage: this.byInvoice.get(bolt11) ?? "ff".repeat(32) };
  }
}

/** A paid downstream MCP tool reachable through a real SDK client. */
async function paidDownstream(wallet: HybridWallet, priceSat: number) {
  const pay = createPaywall({
    rails: [l402Rail({ secret: SECRET, invoiceProvider: wallet.invoiceProvider })],
  });
  const handler: ToolHandler = pay({ price: { amount: priceSat }, resource: "paid_tool" }, async () => ({
    content: [{ type: "text", text: "PAID RESULT" }],
  }));
  const server = new McpServer({ name: "downstream", version: "0.0.0" });
  server.registerTool("paid_tool", { description: "paid", inputSchema: {} }, ((
    args: Record<string, unknown>,
    extra: { _meta?: Record<string, unknown> },
  ) => handler(args, extra)) as never);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

/** Mock an L402 gateway: 402 with a priced challenge, then 200 once paid. */
function mockGateway(priceSat: number) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls % 2 === 1) {
      return new Response(JSON.stringify({ amountSats: priceSat }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc_gateway"' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

describe("one Budget across the HTTP-402 and MCP payment paths", () => {
  test("both paths draw from the same pool; the third call is refused on EITHER path", async () => {
    const wallet = new HybridWallet();
    const budget = new Budget({ maxTotal: { sat: 10 } });
    const l402Client = new L402Client({ wallet, budget });
    const toolClient = new ToolClient({ payers: [l402Payer({ wallet })], budget });
    const downstream = await paidDownstream(wallet, 5);

    // 5 sats over HTTP…
    mockGateway(5);
    const resp = await l402Client.request("https://x.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
    expect(budget.spentFor("sat")).toBe(5);

    // …plus 5 sats over MCP = the whole pool.
    const result = await toolClient.callTool(downstream, "paid_tool");
    expect(result.content[0].text).toBe("PAID RESULT");
    expect(budget.spentFor("sat")).toBe(10);
    expect(budget.remainingFor("sat")).toBe(0);

    // Now BOTH paths must refuse.
    mockGateway(5);
    await expect(l402Client.request("https://x.gw.bolthub.ai/v1/data")).rejects.toThrow(L402BudgetError);
    await expect(toolClient.callTool(downstream, "paid_tool")).rejects.toThrow(PaymentBudgetError);
    expect(budget.spentFor("sat")).toBe(10); // refusals reserve nothing
  });

  test("spend order doesn't matter: MCP first also blocks the HTTP path", async () => {
    const wallet = new HybridWallet();
    const budget = new Budget({ maxTotal: { sat: 6 } });
    const l402Client = new L402Client({ wallet, budget });
    const toolClient = new ToolClient({ payers: [l402Payer({ wallet })], budget });
    const downstream = await paidDownstream(wallet, 5);

    await toolClient.callTool(downstream, "paid_tool");
    expect(budget.spentFor("sat")).toBe(5);

    mockGateway(5); // only 1 sat of headroom left
    await expect(l402Client.request("https://x.gw.bolthub.ai/v1/data")).rejects.toThrow(L402BudgetError);
  });

  test("a failed wallet payment rolls back, restoring headroom for the other path", async () => {
    const wallet = new HybridWallet();
    const budget = new Budget({ maxTotal: { sat: 5 } });
    const l402Client = new L402Client({ wallet, budget, payRetries: 0 });
    const toolClient = new ToolClient({ payers: [l402Payer({ wallet })], budget });
    const downstream = await paidDownstream(wallet, 5);

    mockGateway(5);
    wallet.failNext = true;
    await expect(l402Client.request("https://x.gw.bolthub.ai/v1/data")).rejects.toThrow();
    expect(budget.spentFor("sat")).toBe(0); // rolled back

    // The MCP path can still use the full pool.
    const result = await toolClient.callTool(downstream, "paid_tool");
    expect(result.content[0].text).toBe("PAID RESULT");
    expect(budget.spentFor("sat")).toBe(5);
  });

  test("budget.sat = 0 means free-tools-only on both paths", async () => {
    const wallet = new HybridWallet();
    const budget = new Budget({ maxTotal: { sat: 0 } });
    const l402Client = new L402Client({ wallet, budget });
    const toolClient = new ToolClient({ payers: [l402Payer({ wallet })], budget });
    const downstream = await paidDownstream(wallet, 5);

    mockGateway(5);
    await expect(l402Client.request("https://x.gw.bolthub.ai/v1/data")).rejects.toThrow(L402BudgetError);
    await expect(toolClient.callTool(downstream, "paid_tool")).rejects.toThrow(PaymentBudgetError);
  });
});

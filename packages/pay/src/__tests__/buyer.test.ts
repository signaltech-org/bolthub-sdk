import { describe, expect, test } from "bun:test";
import { PayingClient, PaymentBudgetError, getPaymentChallenge } from "../buyer/client";
import { createPaywall } from "../paywall";
import { l402Payer } from "../payers/l402";
import { x402Payer } from "../payers/x402";
import { l402Rail } from "../rails/l402";
import { x402Rail } from "../rails/x402";
import type { FacilitatorClient, X402PaymentPayload, X402Requirements } from "../rails/x402";
import { randomPreimage, sha256Hex } from "../token";
import type { InvoiceProvider, ToolHandler, ToolResult } from "../types";
import type { X402Signer } from "../payers/x402";

const SECRET = "test-secret-at-least-thirty-two-bytes-long!!";

/**
 * A fake MCP transport: a seller registers wrapped handlers via `tool()`, a buyer
 * calls them via `callTool()`. It propagates request `_meta` → `extra._meta`,
 * exactly the contract `@bolthub/pay` relies on. Seller and buyer run real code;
 * only the wire is faked. This is the end-to-end demo, automated.
 */
class FakeMcp {
  private handlers = new Map<string, ToolHandler>();
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
  async callTool(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }) {
    const handler = this.handlers.get(params.name);
    if (!handler) throw new Error(`no such tool: ${params.name}`);
    return handler(params.arguments ?? {}, { _meta: params._meta });
  }
}

/** Simulates the whole Lightning settlement: the invoice provider (seller) and the
 *  wallet (buyer) share a preimage table keyed by invoice string. */
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
      if (!preimage) throw new Error(`unknown invoice: ${bolt11}`);
      return { preimage };
    },
  };
}

class ApproveFacilitator implements FacilitatorClient {
  async verify(_p: X402PaymentPayload, _r: X402Requirements) {
    return { isValid: true, payer: "0xPayer" };
  }
  async settle(_p: X402PaymentPayload, _r: X402Requirements) {
    return { success: true, txHash: "0xtx" };
  }
}

const mockSigner: X402Signer = {
  authorize: async (req) => ({
    x402Version: 1,
    scheme: "exact",
    network: req.network,
    payload: { signature: "0xsig", value: req.maxAmountRequired },
  }),
};

function paidText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

describe("PayingClient end-to-end (seller paywall ↔ buyer client)", () => {
  test("L402: an unpaid call is challenged, paid, and unlocked", async () => {
    const ln = new MockLightning();
    const mcp = new FakeMcp();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: ln.invoiceProvider })] });
    pay.tool(mcp, "premium", "Premium data", {}, { price: { amount: 2000 } }, async () => ({
      content: [{ type: "text", text: "PAID CONTENT" }],
    }));

    const buyer = new PayingClient({ payers: [l402Payer({ wallet: ln.wallet })], maxTotal: { sat: 10_000 } });
    const result = await buyer.callTool(mcp, "premium");

    expect(paidText(result)).toBe("PAID CONTENT");
    expect(result.isError).toBeUndefined();
    expect(buyer.spentFor("sat")).toBe(2000);
    expect(buyer.remainingFor("sat")).toBe(8000);
  });

  test("x402: an unpaid call is challenged, signed, and unlocked", async () => {
    const mcp = new FakeMcp();
    const pay = createPaywall({
      rails: [x402Rail({ network: "base-sepolia", asset: "0xUSDC", payTo: "0xTo", facilitator: new ApproveFacilitator() })],
    });
    pay.tool(mcp, "premium", "Premium data", {}, { price: { amount: 5000, asset: "usdc" } }, async () => ({
      content: [{ type: "text", text: "PAID CONTENT" }],
    }));

    const buyer = new PayingClient({ payers: [x402Payer({ signer: mockSigner })], maxTotal: { usdc: 10_000 } });
    const result = await buyer.callTool(mcp, "premium");

    expect(paidText(result)).toBe("PAID CONTENT");
    expect(buyer.spentFor("usdc")).toBe(5000);
  });

  test("one tool, two rails: buyer preference decides which rail settles", async () => {
    const ln = new MockLightning();
    const makeMcp = () => {
      const mcp = new FakeMcp();
      const pay = createPaywall({
        rails: [
          l402Rail({ secret: SECRET, invoiceProvider: ln.invoiceProvider }),
          x402Rail({ network: "base-sepolia", asset: "0xUSDC", payTo: "0xTo", facilitator: new ApproveFacilitator() }),
        ],
      });
      pay.tool(mcp, "dual", "Dual-rail", {}, { price: [{ amount: 2000, asset: "sat" }, { amount: 5000, asset: "usdc" }] }, async () => ({
        content: [{ type: "text", text: "DUAL" }],
      }));
      return mcp;
    };

    // Prefer x402 (listed first) → pays usdc.
    const preferX402 = new PayingClient({ payers: [x402Payer({ signer: mockSigner }), l402Payer({ wallet: ln.wallet })] });
    expect(paidText(await preferX402.callTool(makeMcp(), "dual"))).toBe("DUAL");
    expect(preferX402.spentFor("usdc")).toBe(5000);
    expect(preferX402.spentFor("sat")).toBe(0);

    // Only an L402 payer → pays sats.
    const onlyL402 = new PayingClient({ payers: [l402Payer({ wallet: ln.wallet })] });
    expect(paidText(await onlyL402.callTool(makeMcp(), "dual"))).toBe("DUAL");
    expect(onlyL402.spentFor("sat")).toBe(2000);
  });

  test("a per-call cap below the price refuses to pay (nothing spent)", async () => {
    const ln = new MockLightning();
    const mcp = new FakeMcp();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: ln.invoiceProvider })] });
    pay.tool(mcp, "premium", "Premium", {}, { price: { amount: 2000 } }, async () => ({ content: [{ type: "text", text: "PAID" }] }));

    const buyer = new PayingClient({ payers: [l402Payer({ wallet: ln.wallet })], maxPerCall: { sat: 1000 } });
    await expect(buyer.callTool(mcp, "premium")).rejects.toBeInstanceOf(PaymentBudgetError);
    expect(buyer.spentFor("sat")).toBe(0);
  });

  test("no payer for the offered rail returns the unpaid challenge", async () => {
    const mcp = new FakeMcp();
    const pay = createPaywall({
      rails: [x402Rail({ network: "base-sepolia", asset: "0xUSDC", payTo: "0xTo", facilitator: new ApproveFacilitator() })],
    });
    pay.tool(mcp, "premium", "Premium", {}, { price: { amount: 5000, asset: "usdc" } }, async () => ({ content: [{ type: "text", text: "PAID" }] }));

    // Buyer only holds an L402 payer; the tool only offers x402.
    const buyer = new PayingClient({ payers: [l402Payer({ wallet: new MockLightning().wallet })] });
    const result = await buyer.callTool(mcp, "premium");
    expect(result.isError).toBe(true);
    expect(getPaymentChallenge(result)?.resource).toBe("premium");
    expect(buyer.spentFor("usdc")).toBe(0);
  });

  test("a free (unpaywalled) tool passes straight through", async () => {
    const mcp = new FakeMcp();
    mcp.tool("free", "Free", {}, async () => ({ content: [{ type: "text", text: "NO CHARGE" }] }));
    const buyer = new PayingClient({ payers: [l402Payer({ wallet: new MockLightning().wallet })] });
    expect(paidText(await buyer.callTool(mcp, "free"))).toBe("NO CHARGE");
  });
});

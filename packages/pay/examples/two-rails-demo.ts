/**
 * Phase-1 demo: ONE paid tool, settled two ways — Lightning (sats) and x402
 * (USDC) — with only the buyer's payer list changed. Run it:
 *
 *   bun run packages/pay/examples/two-rails-demo.ts
 *
 * Everything below the "your infra" comments is a test double standing in for
 * real components (an MCP transport, a Lightning wallet, an x402 facilitator/
 * signer). The seller (`paywall`) and buyer (`PayingClient`) run real code.
 */

import {
  createPaywall,
  getPaymentChallenge,
  l402Payer,
  l402Rail,
  PayingClient,
  x402Payer,
  x402Rail,
} from "../src/index";
import type {
  FacilitatorClient,
  InvoiceProvider,
  ToolHandler,
  X402PaymentPayload,
  X402Requirements,
  X402Signer,
} from "../src/index";

// ── your infra (mocked) ────────────────────────────────────────────────────
// A fake MCP transport: seller registers handlers, buyer calls them, request
// _meta flows to the handler's extra._meta — the contract @bolthub/pay uses.
class FakeMcp {
  private handlers = new Map<string, ToolHandler>();
  tool(name: string, _d: string, _s: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
  callTool(p: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }) {
    const h = this.handlers.get(p.name);
    if (!h) throw new Error(`no such tool: ${p.name}`);
    return h(p.arguments ?? {}, { _meta: p._meta });
  }
}

// A Lightning mock: the invoice provider (seller) and wallet (buyer) share the
// preimage table, simulating end-to-end settlement.
class MockLightning {
  private byInvoice = new Map<string, string>();
  invoiceProvider: InvoiceProvider = {
    createInvoice: async (amountSat) => {
      const { createHash, randomBytes } = await import("node:crypto");
      const preimage = randomBytes(32).toString("hex");
      const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
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

// An x402 facilitator + signer (mocked). In production these are Coinbase's (or
// your self-hosted) facilitator and a viem/ethers-backed signer.
const facilitator: FacilitatorClient = {
  verify: async () => ({ isValid: true, payer: "0xPayer" }),
  settle: async () => ({ success: true, txHash: "0xtx" }),
};
const signer: X402Signer = {
  authorize: async (req: X402Requirements): Promise<X402PaymentPayload> => ({
    x402Version: 1,
    scheme: "exact",
    network: req.network,
    payload: { signature: "0xsig", value: req.maxAmountRequired },
  }),
};

// ── the actual product ──────────────────────────────────────────────────────
function buildServer() {
  const mcp = new FakeMcp();
  const pay = createPaywall({
    rails: [
      l402Rail({ secret: "demo-secret-at-least-thirty-two-bytes!!", invoiceProvider: ln.invoiceProvider }),
      x402Rail({ network: "base-sepolia", asset: "0xUSDC", payTo: "0xMerchant", facilitator }),
    ],
  });

  // One tool, priced in BOTH assets. Handler runs only after payment verifies.
  pay.tool(
    mcp,
    "get_satellite_image",
    "Recent high-res satellite imagery.",
    {},
    { price: [{ amount: 2000, asset: "sat" }, { amount: 5000, asset: "usdc" }] },
    async () => ({ content: [{ type: "text", text: "🛰️  <512KB image bytes>" }] }),
  );
  return mcp;
}

const ln = new MockLightning();

async function run() {
  // Peek at the challenge an unpaid call gets.
  const probe = await buildServer().callTool({ name: "get_satellite_image" });
  const challenge = getPaymentChallenge(probe)!;
  console.log("Unpaid call → challenge offers:");
  for (const o of challenge.offers) console.log(`   • ${o.scheme.padEnd(5)} ${o.amount} ${o.asset}`);

  // Buyer A prefers Lightning.
  const alice = new PayingClient({
    payers: [l402Payer({ wallet: ln.wallet }), x402Payer({ signer })],
    maxTotal: { sat: 10_000, usdc: 10_000 },
    onPaid: (i) => console.log(`\nAlice paid ${i.amount} ${i.asset} via ${i.scheme}`),
  });
  const a = await alice.callTool(buildServer(), "get_satellite_image");
  console.log("Alice got:", a.content[0].text, "| spent:", `${alice.spentFor("sat")} sat`);

  // Buyer B prefers x402 — SAME tool, SAME code, different payer order.
  const bob = new PayingClient({
    payers: [x402Payer({ signer }), l402Payer({ wallet: ln.wallet })],
    maxTotal: { sat: 10_000, usdc: 10_000 },
    onPaid: (i) => console.log(`Bob paid ${i.amount} ${i.asset} via ${i.scheme}`),
  });
  const b = await bob.callTool(buildServer(), "get_satellite_image");
  console.log("Bob got:  ", b.content[0].text, "| spent:", `${bob.spentFor("usdc")} usdc`);

  console.log("\n✅ One tool. Two rails. The buyer chose.");
}

run();

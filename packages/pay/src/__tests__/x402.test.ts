import { describe, expect, test } from "bun:test";
import { x402Rail } from "../rails/x402";
import type { FacilitatorClient, X402PaymentPayload, X402Requirements } from "../rails/x402";
import type { VerifyContext } from "../types";

const NETWORK = "base-sepolia";
const ASSET = "0xUSDCtokenContractAddress";
const PAY_TO = "0xRecipientAddress";

/** Facilitator stub whose verdict the test controls. Records what it was asked to verify. */
class StubFacilitator implements FacilitatorClient {
  calls: { payment: X402PaymentPayload; requirements: X402Requirements }[] = [];
  constructor(
    private readonly verdict: boolean,
    private readonly settled: boolean = true,
  ) {}
  async verify(payment: X402PaymentPayload, requirements: X402Requirements) {
    this.calls.push({ payment, requirements });
    return this.verdict ? { isValid: true, payer: "0xPayer" } : { isValid: false, invalidReason: "insufficient_funds" };
  }
  async settle(_p: X402PaymentPayload, _r: X402Requirements) {
    return this.settled ? { success: true, txHash: "0xtx" } : { success: false, errorReason: "broadcast_failed" };
  }
}

const ctx: VerifyContext = { resource: "get_image", price: { amount: 5000, asset: "usdc" } };

function xPayment(overrides: Partial<X402PaymentPayload> = {}): string {
  const payload: X402PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: NETWORK,
    payload: { signature: "0xsig", authorization: { value: "5000" } },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("x402Rail", () => {
  test("createOffer emits x402 payment requirements", async () => {
    const rail = x402Rail({ network: NETWORK, asset: ASSET, payTo: PAY_TO, facilitator: new StubFacilitator(true) });
    const offer = await rail.createOffer({ amount: 5000, asset: "usdc" }, "get_image");
    expect(offer.scheme).toBe("x402");
    expect(offer.amount).toBe(5000);
    expect(offer.network).toBe(NETWORK);
    const accepts = offer.accepts as X402Requirements[];
    expect(accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, maxAmountRequired: "5000", payTo: PAY_TO, asset: ASSET, resource: "get_image" });
  });

  test("createOffer rejects a non-usdc price", async () => {
    const rail = x402Rail({ network: NETWORK, asset: ASSET, payTo: PAY_TO, facilitator: new StubFacilitator(true) });
    await expect(rail.createOffer({ amount: 2000, asset: "sat" }, "get_image")).rejects.toThrow(/settles in "usdc"/);
  });

  test("verify accepts a payment the facilitator approves, and reconstructs requirements from the offered price", async () => {
    const facilitator = new StubFacilitator(true);
    const rail = x402Rail({ network: NETWORK, asset: ASSET, payTo: PAY_TO, facilitator });
    const result = await rail.verify(xPayment(), ctx);
    expect(result.ok).toBe(true);
    expect(result.amount).toBe(5000);
    // The seller, not the client, set the amount the facilitator verified against.
    expect(facilitator.calls[0].requirements.maxAmountRequired).toBe("5000");
    expect(facilitator.calls[0].requirements.resource).toBe("get_image");
  });

  test("verify rejects a payment the facilitator declines", async () => {
    const rail = x402Rail({ network: NETWORK, asset: ASSET, payTo: PAY_TO, facilitator: new StubFacilitator(false) });
    const result = await rail.verify(xPayment(), ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_funds");
  });

  test("verify rejects when settlement fails", async () => {
    const rail = x402Rail({ network: NETWORK, asset: ASSET, payTo: PAY_TO, facilitator: new StubFacilitator(true, false) });
    const result = await rail.verify(xPayment(), ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("broadcast_failed");
  });

  test("verify rejects malformed and scheme/network-mismatched payloads", async () => {
    const rail = x402Rail({ network: NETWORK, asset: ASSET, payTo: PAY_TO, facilitator: new StubFacilitator(true) });
    expect((await rail.verify("!!!not-base64-json", ctx)).ok).toBe(false);
    expect((await rail.verify(xPayment({ network: "ethereum-mainnet" }), ctx)).ok).toBe(false);
    expect((await rail.verify(xPayment({ scheme: "upto" }), ctx)).ok).toBe(false);
  });

  test("can skip settlement when settle:false", async () => {
    const facilitator = new StubFacilitator(true, false); // settle would fail…
    const rail = x402Rail({ network: NETWORK, asset: ASSET, payTo: PAY_TO, facilitator, settle: false });
    const result = await rail.verify(xPayment(), ctx); // …but we never call it
    expect(result.ok).toBe(true);
  });
});

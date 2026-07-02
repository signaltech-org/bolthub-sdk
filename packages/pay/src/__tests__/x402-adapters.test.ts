/**
 * The concrete x402 adapters: `x402Facilitator` (HTTP facilitator client) and
 * `eip3009Signer` (EIP-712 TransferWithAuthorization signing via an injected
 * account). Plus the full buyer→seller loop: offer → sign → verify → settle,
 * with the facilitator's HTTP surface mocked.
 */

import { describe, test, expect } from "bun:test";
import { x402Rail } from "../rails/x402";
import { x402Payer } from "../payers/x402";
import { x402Facilitator } from "../x402/facilitator-client";
import { eip3009Signer, type Eip712Account } from "../x402/signer";
import type { X402Requirements } from "../rails/x402";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";

const REQUIREMENTS: X402Requirements = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "5000",
  resource: "get_satellite_image",
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  asset: USDC_BASE_SEPOLIA,
  extra: { name: "USDC", version: "2" },
};

/** A fetch mock that records requests and replays canned JSON responses. */
function fetchMock(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

/** A fake viem-shaped account that records what it was asked to sign. */
function fakeAccount(): Eip712Account & { signed: Array<Record<string, unknown>> } {
  const signed: Array<Record<string, unknown>> = [];
  return {
    address: BUYER,
    signed,
    async signTypedData(params) {
      signed.push(params as unknown as Record<string, unknown>);
      return `0x${"ab".repeat(65)}`;
    },
  };
}

describe("x402Facilitator", () => {
  test("verify POSTs the standard body and maps the response", async () => {
    const { fn, calls } = fetchMock([{ body: { isValid: true, payer: BUYER } }]);
    const fac = x402Facilitator({ url: "https://fac.example/x402/", fetch: fn });

    const payment = { x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} };
    const result = await fac.verify(payment, REQUIREMENTS);

    expect(result).toEqual({ isValid: true, invalidReason: undefined, payer: BUYER });
    expect(calls[0].url).toBe("https://fac.example/x402/verify"); // trailing slash normalised
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.x402Version).toBe(1);
    expect(body.paymentPayload).toEqual(payment);
    expect(body.paymentRequirements).toEqual(REQUIREMENTS);
  });

  test("settle maps both `transaction` and legacy `txHash` fields", async () => {
    const paymentStub = { x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} };
    for (const field of ["transaction", "txHash"]) {
      const { fn } = fetchMock([{ body: { success: true, [field]: "0xdeadbeef" } }]);
      const fac = x402Facilitator({ url: "https://fac.example", fetch: fn });
      const result = await fac.settle!(paymentStub, REQUIREMENTS);
      expect(result).toEqual({ success: true, txHash: "0xdeadbeef", errorReason: undefined });
    }
  });

  test("merges static headers with the per-request auth hook", async () => {
    const { fn, calls } = fetchMock([{ body: { isValid: true } }]);
    const fac = x402Facilitator({
      url: "https://fac.example",
      headers: { "x-api-key": "static" },
      authHeaders: async (path) => ({ authorization: `Bearer jwt-for-${path}` }),
      fetch: fn,
    });
    await fac.verify({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} }, REQUIREMENTS);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("static");
    expect(headers.authorization).toBe("Bearer jwt-for-verify");
  });

  test("degrades HTTP and transport failures to invalid/failed, never throws", async () => {
    const { fn } = fetchMock([{ status: 500, body: { error: "boom" } }]);
    const fac = x402Facilitator({ url: "https://fac.example", fetch: fn });
    const payment = { x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {} };

    const verify = await fac.verify(payment, REQUIREMENTS);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toContain("HTTP 500");

    const unreachable = x402Facilitator({
      url: "https://fac.example",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof globalThis.fetch,
    });
    const settle = await unreachable.settle!(payment, REQUIREMENTS);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toContain("unreachable");
  });
});

describe("eip3009Signer", () => {
  test("signs the canonical TransferWithAuthorization typed data", async () => {
    const account = fakeAccount();
    const signer = eip3009Signer({ account, now: () => 1_000_000 });

    const payment = await signer.authorize(REQUIREMENTS);

    const params = account.signed[0] as {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    expect(params.domain).toEqual({
      name: "USDC", // from requirements.extra
      version: "2",
      chainId: 84532, // base-sepolia
      verifyingContract: USDC_BASE_SEPOLIA,
    });
    expect(params.primaryType).toBe("TransferWithAuthorization");
    expect(params.message.from).toBe(BUYER);
    expect(params.message.to).toBe(PAY_TO);
    expect(params.message.value).toBe(5000n);
    expect(params.message.validAfter).toBe(0n);
    expect(params.message.validBefore).toBe(BigInt(1_000_000 + 120));

    // The JSON payload keeps uint256 values as strings and is serialisable.
    const auth = (payment.payload as { authorization: Record<string, string> }).authorization;
    expect(auth.value).toBe("5000");
    expect(auth.validBefore).toBe(String(1_000_000 + 120));
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => JSON.stringify(payment)).not.toThrow();
    expect(payment.scheme).toBe("exact");
    expect(payment.network).toBe("base-sepolia");
  });

  test("nonces are unique per authorization", async () => {
    const signer = eip3009Signer({ account: fakeAccount() });
    const a = await signer.authorize(REQUIREMENTS);
    const b = await signer.authorize(REQUIREMENTS);
    const nonce = (p: typeof a) => (p.payload as { authorization: { nonce: string } }).authorization.nonce;
    expect(nonce(a)).not.toBe(nonce(b));
  });

  test("unknown network throws unless a chain id is provided", async () => {
    const signer = eip3009Signer({ account: fakeAccount() });
    expect(signer.authorize({ ...REQUIREMENTS, network: "made-up-chain" })).rejects.toThrow(
      /unknown network/,
    );

    const custom = eip3009Signer({ account: fakeAccount(), chainIds: { "made-up-chain": 999 } });
    const payment = await custom.authorize({ ...REQUIREMENTS, network: "made-up-chain" });
    expect(payment.network).toBe("made-up-chain");
  });
});

describe("full x402 loop with concrete adapters", () => {
  test("offer → sign → verify → settle round trip", async () => {
    // Facilitator that accepts everything and settles with a tx hash.
    const { fn, calls } = fetchMock([
      { body: { isValid: true, payer: BUYER } },
      { body: { success: true, transaction: "0xfeed" } },
    ]);

    const rail = x402Rail({
      network: "base-sepolia",
      asset: USDC_BASE_SEPOLIA,
      payTo: PAY_TO,
      assetSymbol: "usdc",
      extra: { name: "USDC", version: "2" },
      maxTimeoutSeconds: 120,
      facilitator: x402Facilitator({ url: "https://fac.example", fetch: fn }),
    });
    const payer = x402Payer({ signer: eip3009Signer({ account: fakeAccount() }) });

    const offer = await rail.createOffer(
      { amount: 5000, asset: "usdc" },
      "get_satellite_image",
    );
    const { proof } = await payer.pay(offer);
    const result = await rail.verify(proof, {
      price: { amount: 5000, asset: "usdc" },
      resource: "get_satellite_image",
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2); // verify then settle

    // The seller reconstructed requirements from its own config — the
    // facilitator saw OUR amount and payTo, not anything client-supplied.
    const verifyBody = JSON.parse(String(calls[0].init.body));
    expect(verifyBody.paymentRequirements.maxAmountRequired).toBe("5000");
    expect(verifyBody.paymentRequirements.payTo).toBe(PAY_TO);
    // And the buyer's signed authorization matches those requirements.
    expect(verifyBody.paymentPayload.payload.authorization.to).toBe(PAY_TO);
    expect(verifyBody.paymentPayload.payload.authorization.value).toBe("5000");
  });
});

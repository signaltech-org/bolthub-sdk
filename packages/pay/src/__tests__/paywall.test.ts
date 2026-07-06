import { describe, expect, test } from "bun:test";
import { createPaywall, PAYMENT_META_KEY } from "../paywall";
import { l402Rail } from "../rails/l402";
import { randomPreimage, sha256Hex, verifyL402Token } from "../token";
import type { InvoiceProvider, PaymentChallenge, ToolExtra } from "../types";

const SECRET = "test-secret-at-least-thirty-two-bytes-long!!";

/** Deterministic invoice provider that remembers each invoice's preimage so a
 *  test can "pay" by recovering it. Mirrors what a real wallet does internally. */
class MockInvoices implements InvoiceProvider {
  readonly preimageByHash = new Map<string, string>();
  async createInvoice(amountSat: number) {
    const preimage = randomPreimage();
    const paymentHash = sha256Hex(preimage);
    this.preimageByHash.set(paymentHash, preimage);
    return { invoice: `lnbcmock${amountSat}_${paymentHash.slice(0, 8)}`, paymentHash };
  }
}

function challengeOf(result: { _meta?: Record<string, unknown> }): PaymentChallenge {
  return result._meta?.[PAYMENT_META_KEY] as PaymentChallenge;
}

/** Recover the L402 proof string for a challenge from the mock provider. */
function payChallenge(challenge: PaymentChallenge, invoices: MockInvoices): ToolExtra {
  const offer = challenge.offers.find((o) => o.scheme === "l402")!;
  const token = offer.token as string;
  const verified = verifyL402Token(SECRET, token);
  if (!verified.ok) throw new Error("offer token did not verify");
  const preimage = invoices.preimageByHash.get(verified.payload.paymentHash)!;
  return { _meta: { [PAYMENT_META_KEY]: { scheme: "l402", proof: `${token}:${preimage}` } } };
}

describe("paywall (L402 rail)", () => {
  test("a call with no proof returns a payment_required challenge", async () => {
    const invoices = new MockInvoices();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: invoices })] });
    const handler = pay({ price: { amount: 2000 }, resource: "get_image" }, async () => ({
      content: [{ type: "text", text: "SECRET DATA" }],
    }));

    const result = await handler({});
    expect(result.isError).toBe(true);
    const challenge = challengeOf(result);
    expect(challenge.status).toBe("payment_required");
    expect(challenge.price).toEqual({ amount: 2000, asset: "sat" });
    expect(challenge.resource).toBe("get_image");
    expect(challenge.offers[0].scheme).toBe("l402");
    expect(challenge.offers[0].invoice).toBeDefined();
    // The real handler must NOT have run.
    expect(result.content[0].text).not.toContain("SECRET DATA");
  });

  test("a valid proof unlocks the handler and fires onPaid", async () => {
    const invoices = new MockInvoices();
    const paid: { resource: string; scheme: string }[] = [];
    const pay = createPaywall({
      rails: [l402Rail({ secret: SECRET, invoiceProvider: invoices })],
      onPaid: (info) => paid.push({ resource: info.resource, scheme: info.scheme }),
    });
    const handler = pay({ price: { amount: 2000 }, resource: "get_image" }, async () => ({
      content: [{ type: "text", text: "SECRET DATA" }],
    }));

    const challenge = challengeOf(await handler({}));
    const result = await handler({}, payChallenge(challenge, invoices));

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("SECRET DATA");
    expect(paid).toEqual([{ resource: "get_image", scheme: "l402" }]);
  });

  test("a tampered preimage is rejected", async () => {
    const invoices = new MockInvoices();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: invoices })] });
    const handler = pay({ price: { amount: 2000 }, resource: "get_image" }, async () => ({
      content: [{ type: "text", text: "SECRET DATA" }],
    }));

    const challenge = challengeOf(await handler({}));
    const token = (challenge.offers[0].token as string);
    const badProof: ToolExtra = {
      _meta: { [PAYMENT_META_KEY]: { scheme: "l402", proof: `${token}:${randomPreimage()}` } },
    };
    const result = await handler({}, badProof);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("preimage does not match");
  });

  test("a proof minted for another resource cannot unlock this tool", async () => {
    const invoices = new MockInvoices();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: invoices })] });
    const toolA = pay({ price: { amount: 2000 }, resource: "tool_a" }, async () => ({ content: [{ type: "text", text: "A" }] }));
    const toolB = pay({ price: { amount: 2000 }, resource: "tool_b" }, async () => ({ content: [{ type: "text", text: "B" }] }));

    // Pay tool A, then present A's proof to tool B.
    const proofForA = payChallenge(challengeOf(await toolA({})), invoices);
    const result = await toolB({}, proofForA);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("different resource");
  });

  test("an unsupported scheme is rejected with a fresh challenge", async () => {
    const invoices = new MockInvoices();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: invoices })] });
    const handler = pay({ price: { amount: 2000 }, resource: "get_image" }, async () => ({ content: [{ type: "text", text: "X" }] }));

    const result = await handler({}, { _meta: { [PAYMENT_META_KEY]: { scheme: "bogus", proof: "0xdeadbeef" } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unsupported payment scheme "bogus"');
  });

  test("the .tool registrar defaults resource to the tool name", async () => {
    const invoices = new MockInvoices();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: invoices })] });
    let registered: { name: string; handler: (a: Record<string, unknown>, e?: ToolExtra) => unknown } | undefined;
    const fakeServer = {
      tool(name: string, _description: string, _schema: unknown, handler: (a: Record<string, unknown>, e?: ToolExtra) => unknown) {
        registered = { name, handler };
      },
    };

    pay.tool(fakeServer, "weather", "Get weather", {}, { price: { amount: 10 } }, async () => ({ content: [{ type: "text", text: "sunny" }] }));
    const challenge = challengeOf((await registered!.handler({})) as { _meta?: Record<string, unknown> });
    expect(challenge.resource).toBe("weather");
  });

  test("rejects a missing resource and a non-positive price", () => {
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: new MockInvoices() })] });
    // @ts-expect-error resource omitted on purpose
    expect(() => pay({ price: { amount: 10 } }, async () => ({ content: [] }))).toThrow(/resource/);
    expect(() => pay({ price: { amount: 0 }, resource: "x" }, async () => ({ content: [] }))).toThrow(/positive integer/);
  });

  test("advertise() reflects the configured rails and price", () => {
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: new MockInvoices() })] });
    expect(pay.advertise({ amount: 2000 })).toEqual({
      version: "0.1",
      price: { amount: 2000, asset: "sat" },
      model: "per_call",
      rails: ["l402"],
    });
  });

  test("a tool priced in multiple assets offers one L402 offer per settleable price", async () => {
    const invoices = new MockInvoices();
    const pay = createPaywall({ rails: [l402Rail({ secret: SECRET, invoiceProvider: invoices })] });
    const handler = pay(
      { price: [{ amount: 2000, asset: "sat" }, { amount: 5000, asset: "usd" }], resource: "multi" },
      async () => ({ content: [{ type: "text", text: "MULTI DATA" }] }),
    );

    const challenge = challengeOf(await handler({}));
    // The L402 rail settles only sats, so the usd price is simply not offered.
    expect(challenge.offers.map((o) => o.scheme)).toEqual(["l402"]);
    expect(challenge.offers[0].amount).toBe(2000);

    const result = await handler({}, payChallenge(challenge, invoices));
    expect(result.content[0].text).toBe("MULTI DATA");
  });
});

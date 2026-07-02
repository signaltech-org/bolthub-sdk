import { describe, expect, test } from "bun:test";
import { facilitatorRail, httpFacilitator } from "../rails/facilitator";
import type { FacilitatorTransport } from "../rails/facilitator";
import type { Offer } from "../types";

describe("facilitatorRail", () => {
  test("delegates createOffer and verify to the transport", async () => {
    const calls: string[] = [];
    const offer: Offer = { scheme: "l402", amount: 5, asset: "sat", token: "t", invoice: "lnbc..." };
    const transport: FacilitatorTransport = {
      async mint(req) {
        calls.push(`mint:${req.scheme}:${req.resource}:${req.price.amount}`);
        return offer;
      },
      async verify(req) {
        calls.push(`verify:${req.scheme}:${req.resource}:${req.proof}`);
        return { ok: true, resource: req.resource, amount: req.price.amount };
      },
    };

    const rail = facilitatorRail({ scheme: "l402", assets: ["sat"], transport });
    expect(rail.scheme).toBe("l402");
    expect(rail.assets).toEqual(["sat"]);

    const minted = await rail.createOffer({ amount: 5, asset: "sat" }, "tool_x");
    expect(minted).toBe(offer);

    const result = await rail.verify("tok:pre", { resource: "tool_x", price: { amount: 5, asset: "sat" } });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["mint:l402:tool_x:5", "verify:l402:tool_x:tok:pre"]);
  });

  test("rejects empty assets", () => {
    const transport = { mint: async () => ({}) as Offer, verify: async () => ({ ok: true }) };
    expect(() => facilitatorRail({ scheme: "l402", assets: [], transport })).toThrow(/assets/);
  });
});

describe("httpFacilitator", () => {
  test("POSTs mint/verify with bearer auth and unwraps responses", async () => {
    const seen: { url: string; method?: string; auth?: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), method: init?.method, auth: headers.get("authorization") ?? undefined, body });
      if (String(url).endsWith("/v1/mint")) {
        return new Response(JSON.stringify({ offer: { scheme: "l402", amount: 5, asset: "sat", invoice: "lnbc..." } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, amount: 5 }), { status: 200 });
    }) as unknown as typeof fetch;

    const transport = httpFacilitator({ baseUrl: "https://facilitator.test", apiKey: "sk_seller_123", fetchImpl });

    const offer = await transport.mint({ scheme: "l402", resource: "tool_x", price: { amount: 5, asset: "sat" } });
    expect(offer.invoice).toBe("lnbc...");

    const result = await transport.verify({ scheme: "l402", resource: "tool_x", price: { amount: 5, asset: "sat" }, proof: "tok:pre" });
    expect(result.ok).toBe(true);

    expect(seen[0].url).toBe("https://facilitator.test/v1/mint");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].auth).toBe("Bearer sk_seller_123");
    expect(seen[1].url).toBe("https://facilitator.test/v1/verify");
  });

  test("throws on non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const transport = httpFacilitator({ baseUrl: "https://facilitator.test", apiKey: "bad", fetchImpl });
    await expect(transport.mint({ scheme: "l402", resource: "x", price: { amount: 5, asset: "sat" } })).rejects.toThrow(/401/);
  });
});

import { describe, expect, test } from "bun:test";
import { nanoRail, XNO_RAW } from "../rails/nano";
import type { VerifyResult } from "../types";

const RECEIVE = "nano_37an2qbecn3xbyi8jpkd7wnzucqf9gth7fz8h3dyd4sun8c3nojxn7bw8j1e";

/** Deterministic verifier that mimics a Nano node confirming a send block. */
function makeVerifier(accepted: Set<string>) {
  return async (account: string, amountRaw: string, resource: string) => {
    return accepted.has(`${account}|${amountRaw}|${resource}`);
  };
}

describe("nanoRail", () => {
  test("rejects an account that is not a nano_ address", () => {
    expect(() =>
      nanoRail({ receiveAccount: "not-an-account", verify: async () => false }),
    ).toThrow(/nano_/);
  });

  test("createOffer emits account + price in raw, no expiry", async () => {
    const accepted = new Set<string>();
    const rail = nanoRail({ receiveAccount: RECEIVE, verify: makeVerifier(accepted) });
    const offer = await rail.createOffer({ amount: 2, asset: "XNO" }, "get_price");

    expect(rail.scheme).toBe("nano");
    expect(rail.assets).toEqual(["XNO"]);
    expect(offer.scheme).toBe("nano");
    expect(offer.asset).toBe("XNO");
    expect(offer.account).toBe(RECEIVE);
    expect(offer.expiresAt).toBe(0);
    // 2 XNO = 2 * 10^30 raw
    expect(offer.wwwAuthenticate).toContain(`account="${RECEIVE}"`);
    expect(offer.wwwAuthenticate).toContain(`amount="2"`);
  });

  test("rejects an asset that is not XNO", async () => {
    const rail = nanoRail({ receiveAccount: RECEIVE, verify: async () => false });
    await expect(rail.createOffer({ amount: 1, asset: "sat" }, "x")).rejects.toThrow(/XNO/);
  });

  test("verify passes only when the (injected) node confirms the block", async () => {
    const accepted = new Set([`${RECEIVE}|${(2n * XNO_RAW).toString()}|get_price`]);
    const rail = nanoRail({ receiveAccount: RECEIVE, verify: makeVerifier(accepted) });

    const ok: VerifyResult = await rail.verify("block-hash", {
      resource: "get_price",
      price: { amount: 2, asset: "XNO" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.resource).toBe("get_price");
    expect(ok.amount).toBe(2);

    // Same amount, different resource -> node never saw it -> rejected.
    const wrongRes: VerifyResult = await rail.verify("block-hash", {
      resource: "other_tool",
      price: { amount: 2, asset: "XNO" },
    });
    expect(wrongRes.ok).toBe(false);
    expect(wrongRes.reason).toMatch(/did not verify/);
  });

  test("rejects a missing proof", async () => {
    const rail = nanoRail({ receiveAccount: RECEIVE, verify: async () => true });
    const res: VerifyResult = await rail.verify("", {
      resource: "x",
      price: { amount: 1, asset: "XNO" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/missing nano proof/);
  });
});

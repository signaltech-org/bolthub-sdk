import { describe, test, expect } from "bun:test";
import { bolt11AmountSats } from "../invoice";

describe("bolt11AmountSats", () => {
  test.each([
    ["lnbc2500u1pvjluezpp5abc", 250_000],
    ["lnbc10m1pdata", 1_000_000],
    ["lnbc50n1pdata", 5],
    ["lnbc20000n1pdata", 2_000],
    ["lntb500u1pdata", 50_000],
    ["lntbs100n1pdata", 10],
    ["lnbcrt30u1pdata", 3_000],
    ["LNBC2500U1PDATA", 250_000],
  ])("decodes %s -> %i sats", (invoice, expected) => {
    expect(bolt11AmountSats(invoice)).toBe(expected);
  });

  test.each([
    ["lnbc1pvjluezpp5data"], // amountless: the '1' is the bech32 separator
    ["lntb1pdata"],
    [""],
    ["not-an-invoice"],
    ["lnbc"],
    ["lnbc2500u"], // no separator
    ["lnbc100x1data"], // invalid multiplier
    ["lnxx100u1data"], // unknown prefix
  ])("returns null for %s", (invoice) => {
    expect(bolt11AmountSats(invoice)).toBeNull();
  });

  test("rounds sub-sat amounts", () => {
    expect(bolt11AmountSats("lnbc5p1data")).toBeNull(); // 0.0005 sat -> 0
    expect(bolt11AmountSats("lnbc15000p1data")).toBe(2); // 1.5 sat -> 2
  });
});

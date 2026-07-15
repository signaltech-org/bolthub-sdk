import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client, L402Error } from "../http/client";
import type { WalletAdapter } from "../http/types";

// Prepaid bundles are retired. buyBundle is a deprecated stub that throws and
// pays nothing; use per-call payment or prepaid credit instead.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wallet(): WalletAdapter {
  return { payInvoice: mock(async () => ({ preimage: "beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" })) };
}

describe("buyBundle (retired)", () => {
  test("throws a deprecation error and touches neither the network nor the wallet", async () => {
    const w = wallet();
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    }) as any;

    const client = new L402Client({ wallet: w });
    await expect(
      (client as unknown as { buyBundle: (u: string, n: number) => Promise<unknown> }).buyBundle(
        "https://acme.gw.bolthub.ai/v1/data",
        100,
      ),
    ).rejects.toThrow(L402Error);
    await expect(
      (client as unknown as { buyBundle: (u: string, n: number) => Promise<unknown> }).buyBundle(
        "https://acme.gw.bolthub.ai/v1/data",
        100,
      ),
    ).rejects.toThrow(/retired/);
    expect(calls).toHaveLength(0);
    expect(w.payInvoice).not.toHaveBeenCalled();
  });
});

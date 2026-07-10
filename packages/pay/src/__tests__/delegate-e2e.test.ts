import { describe, test, expect, mock, afterEach } from "bun:test";
import { attenuate } from "../http/delegate";
import { L402Client } from "../http/client";
import type { WalletAdapter } from "../http/types";

// AF-D7 — consuming side. A child credential is just a macaroon: a second
// process spends it through a plain L402Client with zero delegation-aware code
// and never pays. The parent minted it offline (attenuate); the worker presents
// it and the gateway (mocked here) admits it. The real signature/caveat/grant
// enforcement is covered by the Go verifier + cross-language caveat vectors.

const GATEWAY_MACAROON =
  "AgEHYm9sdGh1YgJFeyJ2IjoxLCJraWQiOiIwNjZlYTZmNCIsInRpZCI6IjhlNDU5NzMxLTgwYWYtNGI4Mi1hODFkLTYyMjJlYjJjOTEyZSJ9AAJNcGF5bWVudF9oYXNoPTUxYjAxOWZkOWZkMTM5OTk1OWIzYWVkODI1NDlmMGZiYjFjN2E5Zjc5NmM5MGFjOWUwYzFiNmQwMmY2NzgyMjMAAi50ZW5hbnRfaWQ9OGU0NTk3MzEtODBhZi00YjgyLWE4MWQtNjIyMmViMmM5MTJlAAIwZW5kcG9pbnRfaWQ9ZWFjODZjMzYtYTgxOC00ODIyLTg2YzYtNDE0NDc3YTVmYzk2AAIYZXhwaXJlc19hdD0xNzgyNDc5NTgzMzY2AAAGIIBZfBD3S6tz8Gf4+vfShVH2hwfwB8vRR2swa4N3tAXC";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("delegation consuming side (AF-D7)", () => {
  test("a second client spends a child token via plain get() with no payment", async () => {
    // Parent narrows its credential offline and hands (child, same preimage) on.
    const preimage = "beef";
    const child = attenuate(GATEWAY_MACAROON, { nUses: 5, pathPrefix: "/v1/data" });
    const childCred = `L402 ${child}:${preimage}`;

    // A different process: fresh client, its own wallet that must never fire,
    // no cached bundle/session, and no idea the credential is a delegated child.
    const wallet: WalletAdapter = { payInvoice: mock(async () => ({ preimage: "unused" })) };
    const worker = new L402Client({ wallet });

    // Gateway stand-in: 200 iff the child credential is presented, else 402.
    const seen: (string | null)[] = [];
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      seen.push(auth);
      if (auth === childCred) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("pay", {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="x", invoice="lnbc1..."' },
      });
    }) as any;

    const res = await worker.get("https://acme.gw.bolthub.ai/v1/data", {
      headers: { Authorization: childCred },
    });

    expect(res.status).toBe(200);
    expect(wallet.payInvoice).not.toHaveBeenCalled(); // spent, not paid
    expect(seen).toEqual([childCred]); // one request, credential presented as-is
  });

  test("without the child credential the same endpoint 402s (the credential is what unlocks it)", async () => {
    const wallet: WalletAdapter = {
      payInvoice: mock(async () => {
        throw new Error("boom: worker has no budget to pay");
      }),
    };
    const worker = new L402Client({ wallet, budgetSats: 0 });

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth) return new Response("{}", { status: 200 });
      return new Response("pay", {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="x", invoice="lnbc1..."' },
      });
    }) as any;

    // No Authorization → 402 → the worker can't pay (zero budget) → it throws,
    // proving the child credential (not the client) is what grants access.
    await expect(worker.get("https://acme.gw.bolthub.ai/v1/data")).rejects.toThrow();
  });
});

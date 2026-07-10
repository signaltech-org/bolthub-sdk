import { describe, test, expect, mock, afterEach } from "bun:test";
import { L402Client } from "../http/client";
import type { WalletAdapter } from "../http/types";

// The challenge parser dual-accepts token= and macaroon= (AF-G6), hedging the
// L402 token-agnostic rename (bLIP-0026). parseChallenge is private, so drive
// it through the full pay flow and assert the credential is echoed back in the
// Authorization header.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function wallet(preimage = "aa"): WalletAdapter {
  return { payInvoice: mock(async () => ({ preimage })) };
}

function capture() {
  const authHeaders: (string | null)[] = [];
  let i = 0;
  globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization");
    authHeaders.push(auth);
    if (i++ === 0) {
      // first call: 402 challenge (varies per test, set below via closure)
      return (capture as any)._challenge as Response;
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
  return authHeaders;
}

function run(wwwAuth: string) {
  (capture as any)._challenge = new Response(
    JSON.stringify({ error: "Payment Required", amountSats: 10 }),
    { status: 402, headers: { "WWW-Authenticate": wwwAuth } },
  );
  return capture();
}

describe("challenge dual-accept (token= / macaroon=)", () => {
  test("token= credential is parsed, paid, and echoed in Authorization", async () => {
    const client = new L402Client({ wallet: wallet("beef") });
    const authHeaders = run('L402 token="tok456", invoice="lnbc1000..."');

    const resp = await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(resp.status).toBe(200);
    // The retry (2nd fetch) carries L402 <token>:<preimage>.
    expect(authHeaders[1]).toBe("L402 tok456:beef");
  });

  test("macaroon= still works and wins when both are present", async () => {
    const client = new L402Client({ wallet: wallet("beef") });
    const authHeaders = run('L402 macaroon="mac", token="tok", invoice="lnbc1000..."');

    await client.get("https://acme.gw.bolthub.ai/v1/data");
    expect(authHeaders[1]).toBe("L402 mac:beef");
  });

  test("a challenge with neither credential is unpayable (throws)", async () => {
    const client = new L402Client({ wallet: wallet() });
    run('L402 invoice="lnbc1000..."'); // no macaroon/token

    await expect(client.get("https://acme.gw.bolthub.ai/v1/data")).rejects.toThrow();
  });
});

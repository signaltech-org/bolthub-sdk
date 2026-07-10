import { describe, test, expect, mock, afterEach } from "bun:test";
import { handleSearchApis, handleGetApiDetails, handlePreviewCost, handleCallApi, handleBuyBundle, handleMintScopedToken, handleRevokeToken } from "../sources/marketplace-tools";
import type { ApiClient, DirectoryEntry } from "../sources/api-client";
import type { L402Client } from "@bolthub/pay";

function makeEntry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    slug: "test-api",
    name: "Test API",
    description: "A test API",
    tags: ["testing"],
    gatewayDomain: "gw.bolthub.ai",
    endpointCount: 1,
    endpoints: [
      {
        path: "/v1/data",
        method: "GET",
        title: "Get data",
        description: "Returns test data",
        docsUrl: null,
        pricingModel: "per_request",
        priceSats: 10,
        tokenBudget: null,
        durationMinutes: null,
        unitCostSats: null,
        freeTryEnabled: false,
        exampleRequest: null,
        exampleResponse: { data: "hello" },
      },
    ],
    ...overrides,
  };
}

function makeApiClient(entries: DirectoryEntry[] = [makeEntry()]): ApiClient {
  return {
    searchApis: mock(async () => entries),
    getApiDetails: mock(async (slug: string) => {
      const found = entries.find((e) => e.slug === slug);
      if (!found) throw new Error(`API "${slug}" not found in the bolthub directory`);
      return found;
    }),
    getGatewayUrl: (slug: string, path = "/") =>
      `https://${slug}.gw.bolthub.ai${path.startsWith("/") ? path : `/${path}`}`,
  } as any;
}

function makeL402Client(overrides: Partial<L402Client> = {}): L402Client {
  return {
    totalSpent: 0,
    remainingBudget: Infinity,
    request: mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ...overrides,
  } as any;
}

describe("handleSearchApis", () => {
  test("returns formatted listing for found APIs", async () => {
    const apiClient = makeApiClient();
    const result = await handleSearchApis({ query: "test" }, apiClient);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Test API");
    expect(result.content[0].text).toContain("test-api");
  });

  test("returns hint when no APIs found", async () => {
    const apiClient = makeApiClient([]);
    const result = await handleSearchApis({ query: "nonexistent" }, apiClient);

    expect(result.content[0].text).toContain("No APIs found");
  });

  test("returns error on API failure", async () => {
    const apiClient = makeApiClient();
    (apiClient.searchApis as any) = mock(async () => { throw new Error("Network error"); });

    const result = await handleSearchApis({}, apiClient);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network error");
  });
});

describe("handleGetApiDetails", () => {
  test("returns detailed API info", async () => {
    const apiClient = makeApiClient();
    const result = await handleGetApiDetails({ slug: "test-api" }, apiClient);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Test API");
    expect(result.content[0].text).toContain("GET /v1/data");
    expect(result.content[0].text).toContain("10 sats");
  });

  test("lists endpoint parameters when present", async () => {
    const apiClient = makeApiClient([
      makeEntry({
        endpoints: [
          {
            path: "/v1/items/{id}",
            method: "GET",
            title: null,
            description: "Item",
            docsUrl: null,
            pricingModel: "per_request",
            priceSats: 5,
            tokenBudget: null,
            durationMinutes: null,
            unitCostSats: null,
            freeTryEnabled: false,
            exampleRequest: null,
            exampleResponse: null,
            parameters: [
              { name: "id", in: "path", required: true, type: "string", description: "Item id" },
              { name: "verbose", in: "query", required: false, type: "boolean" },
            ],
          },
        ],
      }),
    ]);
    const result = await handleGetApiDetails({ slug: "test-api" }, apiClient);

    expect(result.content[0].text).toContain("Parameters:");
    expect(result.content[0].text).toContain("id [path]");
    expect(result.content[0].text).toContain("verbose [query]");
  });

  test("returns error for unknown slug", async () => {
    const apiClient = makeApiClient();
    const result = await handleGetApiDetails({ slug: "unknown" }, apiClient);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

describe("handlePreviewCost", () => {
  test("shows pricing for all endpoints", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client();
    const result = await handlePreviewCost({ slug: "test-api" }, apiClient, l402Client);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("GET /v1/data");
    expect(result.content[0].text).toContain("10 sats");
  });

  test("filters by path and method", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client();
    const result = await handlePreviewCost(
      { slug: "test-api", path: "/v1/data", method: "GET" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("GET /v1/data");
  });

  test("shows budget info when budget is set", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({ totalSpent: 50, remainingBudget: 950 } as any);
    const result = await handlePreviewCost({ slug: "test-api" }, apiClient, l402Client);

    expect(result.content[0].text).toContain("50 sats spent");
    expect(result.content[0].text).toContain("950 sats remaining");
  });
});

describe("handleCallApi", () => {
  test("calls gateway and returns response", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client();
    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"ok": true');
  });

  test("returns error on HTTP failure", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async () => new Response("bad request", { status: 400 })),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 400");
  });

  test("returns error on network failure", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async () => { throw new Error("Connection refused"); }),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Connection refused");
  });

  test("annotates reverted payments so agents know the retry is free", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async () =>
        new Response("upstream down", {
          status: 502,
          headers: {
            "X-Bolthub-Payment": "reverted",
            "X-Bolthub-Payment-Code": "upstream_failed_retryable",
          },
        }),
      ),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Payment: reverted");
    expect(result.content[0].text).toContain("free");
  });

  test("annotates refunded_to_balance on session-model failures", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async () =>
        new Response("upstream down", {
          status: 500,
          headers: {
            "X-Bolthub-Payment": "refunded_to_balance",
            "X-Bolthub-Payment-Code": "upstream_failed_retryable",
          },
        }),
      ),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.content[0].text).toContain("Payment: refunded to session balance");
  });

  test("annotates charged 4xx answers as staying paid", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      // A fresh payment happened this call: onPaid fires with the cost.
      request: mock(async (_url: string, opts: { onPaid?: (i: { amount: number }) => void }) => {
        opts?.onPaid?.({ amount: 10 });
        return new Response("bad request", {
          status: 400,
          headers: {
            "X-Bolthub-Payment": "charged",
            "X-Bolthub-Payment-Code": "upstream_rejected",
          },
        });
      }),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.content[0].text).toContain("Payment: charged (4xx answers are real responses and stay paid)");
  });

  // A call served by a cached prepaid credential is server-"charged" (a use
  // burned) but the wallet paid nothing — the line must say so instead of
  // the misleading "Payment: charged" the smoke test flagged.
  test("labels a no-payment call under a charged header as a prepaid burn", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      // No onPaid: the client presented a cached credential, paid nothing.
      request: mock(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "X-Bolthub-Payment": "charged" },
        }),
      ),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.content[0].text).toContain("Payment: prepaid use burned (no new payment)");
    expect(result.content[0].text).not.toContain("Payment: charged");
  });

  test("no payment line when the gateway does not emit the headers", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async () => new Response("bad request", { status: 400 })),
    } as any);

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.content[0].text).not.toContain("Payment:");
  });

  test("appends cost when sats are spent", async () => {
    let spent = 0;
    const apiClient = makeApiClient();
    // Cost attribution runs through the per-request onPaid callback —
    // totalSpent deltas are racy when the shared budget has other spenders.
    const l402Client = {
      get totalSpent() { return spent; },
      remainingBudget: 990,
      request: mock(async (_url: string, opts: { onPaid?: (i: { amount: number }) => void }) => {
        spent = 10;
        opts.onPaid?.({ amount: 10 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    } as any as L402Client;

    const result = await handleCallApi(
      { slug: "test-api", path: "/v1/data" },
      apiClient,
      l402Client,
    );

    expect(result.content[0].text).toContain("Cost: 10 sats");
  });

  test("sends query params", async () => {
    let capturedUrl = "";
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      request: mock(async (url: string) => {
        capturedUrl = url;
        return new Response("{}", { status: 200 });
      }),
    } as any);

    await handleCallApi(
      { slug: "test-api", path: "/v1/data", query_params: { city: "berlin" } },
      apiClient,
      l402Client,
    );

    expect(capturedUrl).toContain("city=berlin");
  });
});

describe("handleBuyBundle", () => {
  test("buys a bundle and reports the cost + reuse hint", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      buyBundle: mock(async (_url: string, uses: number, opts: { onPaid?: (i: { amount: number }) => void }) => {
        opts.onPaid?.({ amount: 8000 });
        return { uses, resource: "https://test-api.gw.bolthub.ai/v1/data" };
      }),
    } as any);

    const result = await handleBuyBundle(
      { slug: "test-api", path: "/v1/data", uses: 100 },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("100-use bundle");
    expect(result.content[0].text).toContain("Cost: 8000 sats");
    expect(result.content[0].text).toContain("no new payment");
  });

  test("surfaces the server error (e.g. bad size) as an error result", async () => {
    const apiClient = makeApiClient();
    const l402Client = makeL402Client({
      buyBundle: mock(async () => {
        throw new Error("buyBundle: endpoint did not offer this bundle (HTTP 400: No 250-use bundle. Available sizes: 100, 500)");
      }),
    } as any);

    const result = await handleBuyBundle(
      { slug: "test-api", path: "/v1/data", uses: 250 },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Available sizes: 100, 500");
  });

  test("errors when no wallet is configured", async () => {
    const apiClient = makeApiClient();
    const result = await handleBuyBundle(
      { slug: "test-api", path: "/v1/data", uses: 100 },
      apiClient,
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires a wallet");
  });

  test("passes max_cost_sats through to buyBundle", async () => {
    const apiClient = makeApiClient();
    let capturedOpts: { maxCostSats?: number } = {};
    const l402Client = makeL402Client({
      buyBundle: mock(async (_url: string, uses: number, opts: { maxCostSats?: number }) => {
        capturedOpts = opts;
        return { uses, resource: "u" };
      }),
    } as any);

    await handleBuyBundle(
      { slug: "test-api", path: "/v1/data", uses: 100, max_cost_sats: 5000 },
      apiClient,
      l402Client,
    );
    expect(capturedOpts.maxCostSats).toBe(5000);
  });
});

// A real gateway macaroon (header + 4 binding caveats + signature), the value
// attenuate() operates on. Same fixture as the @bolthub/pay delegate tests.
const GATEWAY_MACAROON =
  "AgEHYm9sdGh1YgJFeyJ2IjoxLCJraWQiOiIwNjZlYTZmNCIsInRpZCI6IjhlNDU5NzMxLTgwYWYtNGI4Mi1hODFkLTYyMjJlYjJjOTEyZSJ9AAJNcGF5bWVudF9oYXNoPTUxYjAxOWZkOWZkMTM5OTk1OWIzYWVkODI1NDlmMGZiYjFjN2E5Zjc5NmM5MGFjOWUwYzFiNmQwMmY2NzgyMjMAAi50ZW5hbnRfaWQ9OGU0NTk3MzEtODBhZi00YjgyLWE4MWQtNjIyMmViMmM5MTJlAAIwZW5kcG9pbnRfaWQ9ZWFjODZjMzYtYTgxOC00ODIyLTg2YzYtNDE0NDc3YTVmYzk2AAIYZXhwaXJlc19hdD0xNzgyNDc5NTgzMzY2AAAGIIBZfBD3S6tz8Gf4+vfShVH2hwfwB8vRR2swa4N3tAXC";

describe("handleMintScopedToken", () => {
  function clientHolding(cred?: { macaroon: string; preimage: string }): L402Client {
    return makeL402Client({
      getBundleCredential: mock(() => cred),
      reserveDelegatedCap: mock(() => {}),
      remainingBudget: 1000,
    } as any);
  }

  test("attenuates the held bundle credential into a scoped child", async () => {
    const apiClient = makeApiClient();
    const l402Client = clientHolding({ macaroon: GATEWAY_MACAROON, preimage: "beef" });

    const result = await handleMintScopedToken(
      { slug: "test-api", path: "/v1/data", n_uses: 50, spend_cap_sats: 300 },
      apiClient,
      l402Client,
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain("50 uses");
    expect(text).toContain("≤ 300 sats");
    // The child credential carries the SAME preimage and re-parses as L402.
    const m = text.match(/L402 (\S+):beef/);
    expect(m).not.toBeNull();
    expect(() => atob(m![1])).not.toThrow();
  });

  test("errors when no bundle credential is held (buy_bundle first)", async () => {
    const result = await handleMintScopedToken(
      { slug: "test-api", path: "/v1/data", n_uses: 10 },
      makeApiClient(),
      clientHolding(undefined),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("buy_bundle");
  });

  test("errors when no wallet is configured", async () => {
    const result = await handleMintScopedToken(
      { slug: "test-api", path: "/v1/data", n_uses: 10 },
      makeApiClient(),
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires a wallet");
  });

  test("requires at least one restriction", async () => {
    const result = await handleMintScopedToken(
      { slug: "test-api", path: "/v1/data" },
      makeApiClient(),
      clientHolding({ macaroon: GATEWAY_MACAROON, preimage: "beef" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("restriction");
  });

  test("rejects an unparseable expiry", async () => {
    const result = await handleMintScopedToken(
      { slug: "test-api", path: "/v1/data", expiry: "not-a-date" },
      makeApiClient(),
      clientHolding({ macaroon: GATEWAY_MACAROON, preimage: "beef" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid expiry");
  });

  // AF-D6: the mint reserves the child's spend_cap_sats from the parent budget.
  test("reserves spend_cap_sats from the parent budget on a successful mint", async () => {
    let reserved = 0;
    const l402Client = makeL402Client({
      getBundleCredential: mock(() => ({ macaroon: GATEWAY_MACAROON, preimage: "beef" })),
      reserveDelegatedCap: mock((sats: number) => { reserved = sats; }),
      remainingBudget: 700,
    } as any);

    const result = await handleMintScopedToken(
      { slug: "test-api", path: "/v1/data", spend_cap_sats: 300, n_uses: 50 },
      makeApiClient(),
      l402Client,
    );
    expect(result.isError).toBeUndefined();
    expect(reserved).toBe(300);
    expect(result.content[0].text).toContain("Reserved 300 sats");
  });

  test("refuses a child cap over the parent's remaining budget, minting nothing", async () => {
    const l402Client = makeL402Client({
      getBundleCredential: mock(() => ({ macaroon: GATEWAY_MACAROON, preimage: "beef" })),
      reserveDelegatedCap: mock(() => { throw new Error("Delegated cap 1001 sats exceeds remaining budget 1000"); }),
      remainingBudget: 1000,
    } as any);

    const result = await handleMintScopedToken(
      { slug: "test-api", path: "/v1/data", spend_cap_sats: 1001 },
      makeApiClient(),
      l402Client,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exceeds your remaining budget");
    expect(result.content[0].text).toContain("no token was minted");
    expect(result.content[0].text).not.toContain("L402 "); // no credential leaked
  });
});

describe("handleRevokeToken", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts the held credential to the gateway revoke endpoint and drops it locally", async () => {
    let calledUrl = "";
    let sentAuth: string | null = null;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      calledUrl = url;
      sentAuth = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ revoked: true, code: "token_revoked" }), { status: 200 });
    }) as any;

    const dropped: string[] = [];
    const l402Client = makeL402Client({
      getBundleCredential: mock(() => ({ macaroon: "childmac", preimage: "beef" })),
      dropBundleCredential: mock((u: string) => { dropped.push(u); return true; }),
    } as any);

    const result = await handleRevokeToken({ slug: "test-api", path: "/v1/data" }, makeApiClient(), l402Client);

    expect(result.isError).toBeUndefined();
    expect(calledUrl).toContain("/.well-known/l402/revoke");
    expect(sentAuth).toBe("L402 childmac:beef");
    expect(dropped).toHaveLength(1); // stopped presenting the dead token
    expect(result.content[0].text).toContain("token_revoked");
  });

  test("returns reserved child budget when released_sats is given", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as any;
    let rolledBack = 0;
    const l402Client = makeL402Client({
      getBundleCredential: mock(() => ({ macaroon: "m", preimage: "beef" })),
      dropBundleCredential: mock(() => true),
      rollbackDelegatedCap: mock((n: number) => { rolledBack = n; }),
      remainingBudget: 800,
    } as any);

    const result = await handleRevokeToken(
      { slug: "test-api", path: "/v1/data", released_sats: 300 },
      makeApiClient(),
      l402Client,
    );
    expect(rolledBack).toBe(300);
    expect(result.content[0].text).toContain("Returned 300 sats");
  });

  test("errors when no credential is held for the endpoint", async () => {
    const l402Client = makeL402Client({ getBundleCredential: mock(() => undefined) } as any);
    const result = await handleRevokeToken({ slug: "test-api", path: "/v1/data" }, makeApiClient(), l402Client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nothing to revoke");
  });

  // The gateway's revoke is idempotent: 200 + revoked=false means no active
  // grant matched. Reporting that as success is how the smoke test believed
  // a phantom credential's "revocation" had worked — it must error honestly,
  // while still dropping the dead local credential and returning any named
  // child-cap reservation so the budget can't stay locked.
  test("reports revoked=false honestly instead of claiming success", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ revoked: false, code: "token_revoked" }), { status: 200 }),
    ) as any;
    const dropped: string[] = [];
    let rolledBack = 0;
    const l402Client = makeL402Client({
      getBundleCredential: mock(() => ({ macaroon: "m", preimage: "beef" })),
      dropBundleCredential: mock((u: string) => { dropped.push(u); return true; }),
      rollbackDelegatedCap: mock((n: number) => { rolledBack = n; }),
      remainingBudget: 950,
    } as any);

    const result = await handleRevokeToken(
      { slug: "test-api", path: "/v1/data", released_sats: 50 },
      makeApiClient(),
      l402Client,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No active grant matched");
    expect(result.content[0].text).not.toContain("Revoked the grant");
    expect(dropped).toHaveLength(1); // stale local credential still dropped
    expect(rolledBack).toBe(50); // reservation still returned
    expect(result.content[0].text).toContain("Returned 50 sats");
  });

  test("surfaces a gateway error status", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 404 })) as any;
    const l402Client = makeL402Client({
      getBundleCredential: mock(() => ({ macaroon: "m", preimage: "beef" })),
    } as any);
    const result = await handleRevokeToken({ slug: "test-api", path: "/v1/data" }, makeApiClient(), l402Client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 404");
  });

  test("errors when no wallet is configured", async () => {
    const result = await handleRevokeToken({ slug: "test-api", path: "/v1/data" }, makeApiClient(), undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires a wallet");
  });
});

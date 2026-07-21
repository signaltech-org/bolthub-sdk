import { describe, test, expect, afterEach } from "bun:test";
import {
  handleCreateWorkspace,
  handleConnectWallet,
  handleGetOnboardingState,
  slugify,
} from "../sources/onboarding-tools";
import { handleDeployNode } from "../sources/node-tools";

const API = "https://api.test";
const TOKEN = "jwt-secret-token";

interface Recorded {
  method: string;
  path: string;
  search: string;
  body?: unknown;
}

const originalFetch = globalThis.fetch;
let recorded: Recorded[] = [];

function mockApi(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  recorded = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    recorded.push({ method, path: url.pathname, search: url.search, body });
    const key = `${method} ${url.pathname}${url.search}`;
    const bare = `${method} ${url.pathname}`;
    const handler = routes[key] ?? routes[bare];
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404 });
    }
    const payload = typeof handler === "function" ? (handler as (b: unknown) => unknown)(body) : handler;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TENANT = {
  id: "t-1",
  name: "Acme Data",
  slug: "acme",
  status: "onboarding",
  directoryListed: true,
  trialEndsAt: null,
};

describe("slugify", () => {
  test("kebabs names within the API's slug rules", () => {
    expect(slugify("Acme Data, Inc.")).toBe("acme-data-inc");
    expect(slugify("--Weird  ___ Name!--")).toBe("weird-name");
    expect(slugify("A".repeat(100))).toHaveLength(63);
  });
});

describe("handleCreateWorkspace", () => {
  test("derives a free slug, creates, and never echoes secrets", async () => {
    mockApi({
      "GET /tenants/check-slug?slug=acme-data": { available: false },
      "GET /tenants/check-slug?slug=acme-data-2": { available: true },
      "POST /tenants": (body: unknown) => ({
        tenant: {
          ...TENANT,
          name: (body as { name: string }).name,
          slug: (body as { slug: string }).slug,
          gatewaySecret: "SUPER-SECRET-GW",
          hmacSecret: "SUPER-SECRET-HMAC",
        },
      }),
    });
    const result = await handleCreateWorkspace({ name: "Acme Data" }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("acme-data-2");
    expect(text).toContain("trial only starts");
    expect(text).toContain("connect_wallet");
    // the create response carries gateway/HMAC secrets — they must never leak
    expect(text).not.toContain("SUPER-SECRET");
    const create = recorded.find((r) => r.method === "POST")!;
    expect(create.body).not.toHaveProperty("walletProvider");
    expect(create.body).not.toHaveProperty("walletConfig");
  });

  test("explicit taken slug errors instead of mutating", async () => {
    mockApi({ "GET /tenants/check-slug?slug=acme": { available: false } });
    const result = await handleCreateWorkspace({ name: "Acme", slug: "acme" }, API, TOKEN);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already taken");
    expect(recorded.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("wallet_node_id binds the node as the payout wallet in one call", async () => {
    mockApi({
      "GET /tenants/check-slug?slug=acme-data": { available: true },
      "POST /tenants": (body: unknown) => ({
        tenant: { ...TENANT, name: (body as { name: string }).name, slug: (body as { slug: string }).slug },
      }),
      "POST /nodes/node-9/connect-wallet": {
        connected: true,
        node: { receivingCapacitySat: 50000, activeChannelCount: 2 },
      },
    });
    const result = await handleCreateWorkspace(
      { name: "Acme Data", wallet_node_id: "node-9" },
      API,
      TOKEN,
    );
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("node-9");
    expect(text).toContain("payout wallet");
    const bind = recorded.find((r) => r.path === "/nodes/node-9/connect-wallet");
    expect(bind?.body).toEqual({ tenantId: "t-1" });
  });

  test("suggests binding a ready node when wallet_node_id is omitted", async () => {
    mockApi({
      "GET /tenants/check-slug?slug=acme-data": { available: true },
      "POST /tenants": (body: unknown) => ({ tenant: { ...TENANT, slug: (body as { slug: string }).slug } }),
      "GET /nodes": {
        nodes: [
          { id: "node-7", name: "prod", status: "ready", provider: "lunanode", tenantId: null, hasInvoicesMacaroon: true },
        ],
      },
    });
    const result = await handleCreateWorkspace({ name: "Acme Data" }, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("node-7");
    expect(text).toContain("connect_wallet");
    // no bind fires without an explicit wallet_node_id
    expect(recorded.find((r) => r.path === "/nodes/node-7/connect-wallet")).toBeUndefined();
  });
});

describe("handleConnectWallet", () => {
  test("no wallet, no nodes: browser handoff with LND-first guidance and self-hosted steps", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": { tenant: { ...TENANT, walletConnected: false } },
      "GET /nodes": { nodes: [] },
    });
    const result = await handleConnectWallet({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("/payouts");
    expect(text).toContain("never in this chat");
    expect(text.indexOf("LND")).toBeLessThan(text.indexOf("NWC"));
    expect(text).not.toContain("Phoenixd");
    // NWC payout wallets must be always-on services; phone wallets are
    // flagged as unsuitable, not recommended.
    expect(text).toContain("always-on");
    expect(text).toContain("go offline");
    // self-hosted LND is guided in chat: tunnel + invoice-only macaroon
    expect(text).toContain("bakemacaroon info:read invoices:read invoices:write");
    expect(text).toContain("never hand over admin.macaroon");
    expect(text).toContain("deploy_node");
  });

  test("connected wallet reports provider only, no config", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": {
        tenant: { ...TENANT, walletConnected: true, walletProvider: "lnd", walletReachable: true },
      },
    });
    const result = await handleConnectWallet({}, API, TOKEN);
    expect(result.content[0].text).toContain("Wallet connected");
    expect(result.content[0].text).toContain("lnd");
    expect(result.content[0].text).toContain("never holds funds");
    expect(result.content[0].text).toContain("Reachability checks are passing");
  });

  test("connected but unreachable wallet is an actionable error", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": {
        tenant: { ...TENANT, walletConnected: true, walletProvider: "nwc", walletReachable: false },
      },
    });
    const result = await handleConnectWallet({}, API, TOKEN);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("UNREACHABLE");
    expect(result.content[0].text).toContain("always-on");
  });

  test("one ready deployed node → offers the bind with the exact node_id", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": { tenant: { ...TENANT, walletConnected: false } },
      "GET /nodes": {
        nodes: [
          { id: "node-1", name: "my node", status: "ready", provider: "lunanode", tenantId: null, hasInvoicesMacaroon: true },
          { id: "node-2", name: null, status: "provisioning", provider: "hetzner", tenantId: null, hasInvoicesMacaroon: false },
        ],
      },
    });
    const result = await handleConnectWallet({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain('node_id "node-1"');
    expect(text).toContain("no secrets enter this chat");
    expect(text).not.toContain("node-2 "); // unfinalized node not offered
  });

  test("node_id binds server-side and reports without secrets", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "POST /nodes/node-1/connect-wallet": { connected: true },
    });
    const result = await handleConnectWallet({ node_id: "node-1" }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("payout wallet");
    expect(result.content[0].text).toContain("copied server-side");
    const bind = recorded.find((r) => r.path === "/nodes/node-1/connect-wallet")!;
    expect(bind.body).toEqual({ tenantId: "t-1" });
  });

  test("binding a channel-less node warns that reachable is not payable (H1)", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "POST /nodes/node-1/connect-wallet": {
        connected: true,
        node: { activeChannelCount: 0, receivingCapacitySat: 0 },
      },
    });
    const result = await handleConnectWallet({ node_id: "node-1" }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("CANNOT RECEIVE PAYMENTS");
    expect(text).toContain("NO CHANNELS");
    expect(text).toContain("inbound");
  });

  test("binding a node with inbound capacity reports it as payable", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "POST /nodes/node-1/connect-wallet": {
        connected: true,
        node: { activeChannelCount: 2, receivingCapacitySat: 250_000 },
      },
    });
    const result = await handleConnectWallet({ node_id: "node-1" }, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("250000 sats");
    expect(text).toContain("can receive payments");
    expect(text).not.toContain("CANNOT RECEIVE");
  });
});

describe("handleGetOnboardingState", () => {
  const EP = (over: Record<string, unknown> = {}) => ({
    id: "ep-1",
    path: "/v1/things",
    method: "GET",
    isActive: true,
    directoryListed: false,
    originId: "o-1",
    origin: { id: "o-1", baseUrl: "https://origin.example.com" },
    pricingRules: [{ pricingModel: "per_request", priceSats: 5 }],
    ...over,
  });

  test("node-backed wallet with zero channels reads NOT PAYABLE, next step = inbound channel", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": {
        tenant: {
          ...TENANT,
          walletConnected: true,
          walletReachable: true,
          walletConnectionMethod: "node_launcher",
        },
      },
      "GET /tenants/t-1/endpoints": { endpoints: [EP()] },
      "GET /nodes": {
        nodes: [
          { id: "node-1", name: null, status: "ready", provider: "vultr", tenantId: "t-1", hasInvoicesMacaroon: true, activeChannelCount: 0, receivingCapacitySat: 0 },
        ],
      },
      "POST /tenants/t-1/origins/o-1/check": {
        check: { verdict: "protected", signed: {}, unsigned: {} },
      },
    });
    const result = await handleGetOnboardingState({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("NOT PAYABLE");
    expect(text).toContain("no channels");
    expect(text).toContain("Next: get an inbound channel on node node-1");
  });

  test("mid-onboarding state: drafts + public origin drive the next step", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": { tenant: { ...TENANT, walletConnected: true } },
      "GET /tenants/t-1/endpoints": { endpoints: [EP()] },
      "POST /tenants/t-1/origins/o-1/check": {
        check: { verdict: "public", signed: {}, unsigned: {} },
      },
    });
    const result = await handleGetOnboardingState({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("[x] Wallet connected");
    expect(text).toContain("1 draft, 0 published");
    expect(text).toContain("[!] Origin protection: public");
    expect(text).toContain("not started (starts at first publish)");
    expect(text).toContain("Next: fix origin protection");
    expect(text).toContain("no-code-platform-recipes");
  });

  test("paid drafts + no wallet flags the publish gate in the next step", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": { tenant: { ...TENANT, walletConnected: false } },
      "GET /tenants/t-1/endpoints": { endpoints: [EP()] }, // paid (5 sats), draft
      "POST /tenants/t-1/origins/o-1/check": { check: { verdict: "protected", signed: {}, unsigned: {} } },
    });
    const result = await handleGetOnboardingState({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("Next: connect_wallet");
    expect(text).toContain("paid draft");
    expect(text).toContain("can't be published");
  });

  test("no wallet wins the next-step priority", async () => {
    mockApi({
      "GET /tenants": { tenants: [TENANT] },
      "GET /tenants/t-1": { tenant: { ...TENANT, walletConnected: false } },
      "GET /tenants/t-1/endpoints": { endpoints: [] },
    });
    const result = await handleGetOnboardingState({}, API, TOKEN);
    expect(result.content[0].text).toContain("Next: connect_wallet");
    // no origins → no probes fired
    expect(recorded.some((r) => r.path.includes("/check"))).toBe(false);
  });

  test("fully live workspace points at earnings", async () => {
    mockApi({
      "GET /tenants": { tenants: [{ ...TENANT, status: "active" }] },
      "GET /tenants/t-1": {
        tenant: { ...TENANT, status: "active", walletConnected: true, trialEndsAt: "2026-08-10T00:00:00Z" },
      },
      "GET /tenants/t-1/endpoints": { endpoints: [EP({ directoryListed: true })] },
      "POST /tenants/t-1/origins/o-1/check": {
        check: { verdict: "protected", signed: {}, unsigned: {} },
      },
    });
    const result = await handleGetOnboardingState({}, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("[x] Listing live");
    expect(text).toContain("ends 2026-08-10");
    expect(text).toContain("get_earnings");
  });
});

describe("handleDeployNode v2 (stored credentials)", () => {
  const CRED = { id: "cred-1", provider: "lunanode", label: "personal", apiKeyMasked: "abcd****wxyz" };
  const DEPLOY_ROUTES = {
    "GET /vps-credentials/cred-1/regions": { regions: [{ slug: "tor2", name: "Toronto" }] },
    "GET /vps-credentials/cred-1/sizes?region=tor2": {
      sizes: [{ slug: "m.2", label: "2GB", monthlyCostCents: 350 }],
    },
    "POST /nodes/deploy": {
      node: { id: "node-1", status: "provisioning", vpsIp: null, monthlyCostCents: 350 },
    },
  };

  test("guided flow: region menu → size menu with prices → deploy on size choice", async () => {
    mockApi({ "GET /vps-credentials": { credentials: [CRED] }, ...DEPLOY_ROUTES });

    // step 1: credential auto-picked, region is the user's call
    const step1 = await handleDeployNode({}, API, TOKEN);
    expect(step1.isError).toBeUndefined();
    expect(step1.content[0].text).toContain("Pick a region");
    expect(step1.content[0].text).toContain("tor2");
    expect(recorded.some((r) => r.path === "/nodes/deploy")).toBe(false);

    // step 2: region chosen → sizes with monthly pricing + recommendation
    const step2 = await handleDeployNode({ region: "tor2" }, API, TOKEN);
    expect(step2.content[0].text).toContain("$3.50/mo");
    expect(step2.content[0].text).toContain("← recommended");
    expect(recorded.some((r) => r.path === "/nodes/deploy")).toBe(false);

    // step 3: size "recommended" → deploys
    const step3 = await handleDeployNode({ region: "tor2", size: "recommended" }, API, TOKEN);
    expect(step3.isError).toBeUndefined();
    expect(step3.content[0].text).toContain("node-1");
    expect(step3.content[0].text).toContain("/nodes/node-1"); // seed-phrase page link
    expect(step3.content[0].text).toContain("connect_wallet");
    const deploy = recorded.find((r) => r.path === "/nodes/deploy")!;
    expect(deploy.body).toEqual({
      credentialId: "cred-1",
      region: "tor2",
      size: "m.2",
      torEnabled: false,
    });
  });

  test("no credentials + no provider → provider menu with prices", async () => {
    mockApi({ "GET /vps-credentials": { credentials: [] } });
    const result = await handleDeployNode({}, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("LunaNode");
    expect(text).toContain("~$3.50/mo");
    expect(text).toContain("Vultr");
    expect(recorded.some((r) => r.path === "/nodes/deploy")).toBe(false);
  });

  // L4: a returning user with several credentials still gets the provider/
  // price menu first, never a bare list of opaque credential ids.
  test("multiple credentials + no provider → provider menu with prices and stored marks", async () => {
    mockApi({
      "GET /vps-credentials": {
        credentials: [CRED, { id: "cred-2", provider: "vultr", label: null, apiKeyMasked: "ef**gh" }],
      },
    });
    const result = await handleDeployNode({}, API, TOKEN);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("~$3.50/mo");
    expect(text).toContain("[1 stored credential]");
    expect(text).not.toContain("cred-1");
    expect(recorded.some((r) => r.path === "/nodes/deploy")).toBe(false);
  });

  test("multiple credentials for the chosen provider → credential_id disambiguation", async () => {
    mockApi({
      "GET /vps-credentials": {
        credentials: [CRED, { id: "cred-9", provider: "lunanode", label: "work", apiKeyMasked: "ij**kl" }],
      },
    });
    const result = await handleDeployNode({ provider: "lunanode" }, API, TOKEN);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("credential_id");
    expect(text).toContain("cred-1");
    expect(text).toContain("cred-9");
  });

  test("no credentials + provider chosen → sign-up and token steps, browser link", async () => {
    mockApi({ "GET /vps-credentials": { credentials: [] } });
    const result = await handleDeployNode({ provider: "vultr" }, API, TOKEN);
    const text = result.content[0].text;
    expect(text).toContain("my.vultr.com");
    expect(text).toContain("/nodes/deploy");
    expect(text).toContain("never in this chat");
    expect(text).toContain('provider "vultr"');
  });

  test("invalid region and size choices re-present the menus", async () => {
    mockApi({ "GET /vps-credentials": { credentials: [CRED] }, ...DEPLOY_ROUTES });
    const badRegion = await handleDeployNode({ region: "nope" }, API, TOKEN);
    expect(badRegion.content[0].text).toContain('Region "nope" isn\'t available');
    const badSize = await handleDeployNode({ region: "tor2", size: "huge" }, API, TOKEN);
    expect(badSize.isError).toBe(true);
    expect(badSize.content[0].text).toContain('"recommended"');
  });

  test("deprecated api_key path warns, and a deny-listed 403 becomes browser guidance", async () => {
    mockApi({
      "POST /vps-credentials": { credential: { id: "cred-9" } },
      "GET /vps-credentials/cred-9/regions": { regions: [{ slug: "nbg1", name: "Nuremberg" }] },
      "GET /vps-credentials/cred-9/sizes?region=nbg1": {
        sizes: [{ slug: "cx22", label: "4GB", monthlyCostCents: 549 }],
      },
      "POST /nodes/deploy": {
        node: { id: "node-2", status: "provisioning", vpsIp: null, monthlyCostCents: 549 },
      },
    });
    const legacy = await handleDeployNode(
      { provider: "hetzner", api_key: "hz-key", region: "nbg1", size: "cx22" },
      API,
      TOKEN,
    );
    expect(legacy.content[0].text).toContain("WARNING: passing api_key");

    mockApi({
      "POST /vps-credentials": () => {
        throw new Error("unreachable");
      },
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "This action needs a browser session (log in to the dashboard). Personal access tokens can't touch secrets or credentials." }),
        { status: 403 },
      )) as typeof fetch;
    const denied = await handleDeployNode({ provider: "hetzner", api_key: "hz-key" }, API, TOKEN);
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("Add the key once at https://bolthub.ai/nodes/deploy");
  });
});

import { describe, test, expect, afterEach } from "bun:test";
import { handleNodeStatus, MAX_WAIT_SLICE_S } from "../sources/node-tools";

const API = "https://api.test";
const TOKEN = "jwt-secret-token";

const originalFetch = globalThis.fetch;
let requestCount = 0;

/**
 * Mocks GET /nodes/:id with a SEQUENCE of node states — one per poll, the
 * last state sticking — so a wait can be driven through transitions.
 */
function mockNodeSequence(states: Array<Record<string, unknown>>) {
  requestCount = 0;
  globalThis.fetch = (async () => {
    const state = states[Math.min(requestCount, states.length - 1)];
    requestCount++;
    return new Response(JSON.stringify({ node: { ...BASE_NODE, ...state } }), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE_NODE = {
  id: "node-1",
  status: "provisioning",
  vpsIp: null,
  lndRestHost: null,
  monthlyCostCents: 350,
  lastError: null,
  torAddress: null,
  hasLndMacaroon: false,
  hasLncPairing: false,
  tenantId: null,
};

const FAST = 1; // pollIntervalMs for tests that need several polls
const HUGE = 60_000; // pollIntervalMs bigger than any timeout → first deadline check trips

describe("node_status one-shot (no wait_for)", () => {
  test("reports without polling", async () => {
    mockNodeSequence([{ status: "provisioning" }]);
    const result = await handleNodeStatus({ node_id: "node-1" }, API, TOKEN);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Status: provisioning");
    expect(result.content[0].text).not.toContain("Waited");
    expect(requestCount).toBe(1);
  });
});

describe("node_status wait_for validation", () => {
  test("unknown wait_for is rejected with the valid set", async () => {
    mockNodeSequence([{}]);
    const result = await handleNodeStatus({ node_id: "node-1", wait_for: "synced" }, API, TOKEN);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("wallet_pending, ready, payable");
    expect(requestCount).toBe(0);
  });

  test("timeout_s without wait_for is rejected", async () => {
    mockNodeSequence([{}]);
    const result = await handleNodeStatus({ node_id: "node-1", timeout_s: 60 }, API, TOKEN);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("only makes sense together with wait_for");
    expect(requestCount).toBe(0);
  });

  test("out-of-range timeout_s is rejected", async () => {
    mockNodeSequence([{}]);
    for (const bad of [0, 4, 601, NaN]) {
      const result = await handleNodeStatus(
        { node_id: "node-1", wait_for: "ready", timeout_s: bad },
        API,
        TOKEN,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("between 5 and 600");
    }
    expect(requestCount).toBe(0);
  });
});

describe("node_status wait_for behavior", () => {
  test("a node already past the milestone returns immediately", async () => {
    mockNodeSequence([{ status: "ready" }]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "wallet_pending" },
      API,
      TOKEN,
      FAST,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"wallet_pending" met');
    expect(requestCount).toBe(1);
  });

  test("polls through transitions until the milestone", async () => {
    mockNodeSequence([
      { status: "provisioning" },
      { status: "installing" },
      { status: "wallet_pending" },
    ]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "wallet_pending" },
      API,
      TOKEN,
      FAST,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("(3 check(s))");
    expect(result.content[0].text).toContain("ACTION REQUIRED"); // wallet_pending report follows
    expect(requestCount).toBe(3);
  });

  test("payable waits for measured inbound capacity", async () => {
    mockNodeSequence([
      { status: "ready", activeChannelCount: 0, receivingCapacitySat: 0 },
      { status: "ready", activeChannelCount: null, receivingCapacitySat: null },
      { status: "ready", activeChannelCount: 1, receivingCapacitySat: 50_000 },
    ]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "payable" },
      API,
      TOKEN,
      FAST,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"payable" met');
    expect(result.content[0].text).toContain("ready to receive payments");
    expect(requestCount).toBe(3);
  });

  test("times out loudly with per-target guidance, never silently", async () => {
    mockNodeSequence([{ status: "ready", activeChannelCount: 0, receivingCapacitySat: 0 }]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "payable", timeout_s: 5 },
      API,
      TOKEN,
      HUGE,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("TIMED OUT after 5s");
    expect(text).toContain("on-chain confirmations");
    expect(text).toContain("channels 0");
    expect(requestCount).toBe(1);
  });

  test("a budget above the transport-safe slice pauses instead of blocking to death", async () => {
    // 2026-07-16 smoke finding: Claude Desktop aborts tool calls held open
    // past ~4 minutes, so a 600s in-call wait can never reach its own
    // timeout. The wait must pause at the slice and hand the budget back.
    mockNodeSequence([{ status: "provisioning" }]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "wallet_pending", timeout_s: 600 },
      API,
      TOKEN,
      HUGE * 10, // next poll would overshoot the 150s slice immediately
    );
    expect(result.isError).toBeUndefined(); // a pause is not a failure
    const text = result.content[0].text;
    expect(text).toContain("WAIT PAUSED");
    expect(text).toContain(`at most ${MAX_WAIT_SLICE_S}s per call`);
    expect(text).toContain('wait_for "wallet_pending"');
    expect(text).toMatch(/timeout_s \d+ to continue/);
    expect(text).toContain('still "provisioning"');
    expect(requestCount).toBe(1);
  });

  test("a budget within the slice still times out as an error", async () => {
    mockNodeSequence([{ status: "provisioning" }]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "wallet_pending", timeout_s: MAX_WAIT_SLICE_S },
      API,
      TOKEN,
      HUGE * 10,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`TIMED OUT after ${MAX_WAIT_SLICE_S}s`);
    expect(result.content[0].text).not.toContain("WAIT PAUSED");
  });

  test("terminal error state fails immediately with the node error", async () => {
    mockNodeSequence([{ status: "error", lastError: "VPS quota exceeded" }]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "ready", timeout_s: 600 },
      API,
      TOKEN,
      FAST,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("WAIT FAILED");
    expect(result.content[0].text).toContain("VPS quota exceeded");
    expect(requestCount).toBe(1);
  });

  test("waiting past wallet_pending stops immediately: only the user can advance it", async () => {
    mockNodeSequence([{ status: "wallet_pending" }]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "ready", timeout_s: 600 },
      API,
      TOKEN,
      FAST,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("WAIT STOPPED");
    expect(text).toContain("/nodes/node-1");
    expect(text).toContain("only the user can advance it");
    expect(requestCount).toBe(1);
  });

  test("waiting FOR wallet_pending succeeds when the node reaches it", async () => {
    mockNodeSequence([{ status: "installing" }, { status: "wallet_pending" }]);
    const result = await handleNodeStatus(
      { node_id: "node-1", wait_for: "wallet_pending" },
      API,
      TOKEN,
      FAST,
    );
    expect(result.isError).toBeUndefined();
    expect(requestCount).toBe(2);
  });
});

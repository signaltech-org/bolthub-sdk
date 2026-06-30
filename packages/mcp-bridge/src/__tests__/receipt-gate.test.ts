// SPDX-License-Identifier: Apache-2.0
//
// Tests for the OPT-IN Receipt Required gate (src/receipt-gate.ts).
//
//   1. NO-OP by default     -> with no manifest, the handler is byte-identical
//   2. RR-1 conformance      -> missing -> 428, valid -> runs, replay -> refused,
//                               forged -> refused (via the published harness)
//   3. tool+amount binding   -> a receipt for one tool/price can't drive another

import { describe, test, expect, mock, afterEach } from "bun:test";
import crypto from "node:crypto";
import {
  receiptRequiredConformance,
  RECEIPT_REQUIRED_STATUS,
} from "@emilia-protocol/require-receipt";
import {
  wrapWithReceiptGate,
  loadActionManifest,
  RECEIPT_ARG,
  RECEIPT_AMOUNT_ARG,
} from "../receipt-gate";
import { executeToolCall } from "../tool-handler";
import { L402Client } from "@bolthub/agent";
import type { WalletAdapter } from "@bolthub/agent";
import type { McpToolDefinition } from "../openapi-to-tools";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DANGEROUS_TOOL = "btc-intel_get_premium_report";

function createTool(name = DANGEROUS_TOOL): McpToolDefinition {
  return {
    name,
    description: "Premium report (paid)",
    inputSchema: { type: "object", properties: {} },
    meta: { url: "https://api.example.com/report", method: "GET", path: "/report" },
  };
}

function createMockClient(preimage = "abc123") {
  const wallet: WalletAdapter = { payInvoice: mock(async () => ({ preimage })) };
  return new L402Client({ wallet });
}

const MANIFEST = {
  "@version": "EP-ACTION-RISK-MANIFEST-v0.1",
  service: { name: "bolthub-mcp-bridge", manifest_url: "/.well-known/agent-actions.json" },
  actions: [
    {
      id: "mcp.btc-intel_get_premium_report",
      match: { protocol: "mcp", tool: DANGEROUS_TOOL },
      action_type: "l402.pay",
      risk: "high",
      receipt_required: true,
      assurance_class: "class_a",
      max_age_sec: 900,
      max_amount_sats: 1000,
    },
  ],
};

// Byte-identical to @emilia-protocol/verify's EP-RECEIPT-v1 canonicalization.
const canonicalize = (v: unknown): string =>
  v === null || v === undefined ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(canonicalize).join(",")}]`
      : typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonicalize((v as Record<string, unknown>)[k])).join(",")}}`
        : JSON.stringify(v);

// Mint a FRESH valid EP-RECEIPT-v1 bound to `action`, signed by a device key.
function issueReceipt(action: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const payload = {
    receipt_id: "rcpt_" + crypto.randomBytes(6).toString("hex"),
    subject: "agent:autonomous",
    created_at: new Date().toISOString(),
    claim: { action_type: action, outcome: "allow_with_signoff", approver: "jane.doe@yourco.example" },
  };
  const value = crypto.sign(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64url");
  return { "@version": "EP-RECEIPT-v1", payload, signature: { algorithm: "Ed25519", value }, public_key: pub };
}

describe("loadActionManifest", () => {
  test("returns null when BOLTHUB_AGENT_ACTIONS is unset (gate is off by default)", () => {
    expect(loadActionManifest({})).toBeNull();
  });

  test("throws (fails loud) when the configured manifest path is unreadable", () => {
    expect(() => loadActionManifest({ BOLTHUB_AGENT_ACTIONS: "/no/such/manifest.json" })).toThrow();
  });
});

describe("wrapWithReceiptGate — opt-in / no-op", () => {
  test("with no manifest, returns the EXACT same handler (byte-identical behavior)", () => {
    const handler = mock(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const wrapped = wrapWithReceiptGate(createTool(), handler, null);
    expect(wrapped).toBe(handler);
  });

  test("a tool NOT marked receipt_required passes straight through unchanged", () => {
    const handler = mock(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const wrapped = wrapWithReceiptGate(createTool("free_unlisted_tool"), handler, MANIFEST);
    expect(wrapped).toBe(handler);
  });

  test("an unlisted tool still pays normally even when a manifest is loaded", async () => {
    const client = createMockClient();
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as any;
    const tool = createTool("free_unlisted_tool");
    const handler = (args: Record<string, unknown>) => executeToolCall(tool, args, client);
    const wrapped = wrapWithReceiptGate(tool, handler, MANIFEST);
    const result = await wrapped({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text.split("\n\n---")[0])).toEqual({ ok: true });
  });
});

describe("wrapWithReceiptGate — RR-1 conformance", () => {
  test("missing -> 428, valid -> runs, replay -> refused, forged -> refused", async () => {
    // Adapt the gate-wrapped handler to the conformance harness's dispatch shape.
    const dispatch = async (
      _tool: string,
      args: Record<string, unknown>,
      receipt: object | null,
    ) => {
      const tool = createTool();
      const inner = async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ ran: true }) }] });
      const wrapped = wrapWithReceiptGate(tool, inner, MANIFEST);
      const out = await wrapped({ ...args, [RECEIPT_ARG]: receipt, [RECEIPT_AMOUNT_ARG]: 1000 });
      // Map MCP result -> { status, body } the harness expects.
      if (out.isError) {
        const body = JSON.parse(out.content[0].text);
        return { status: body.status ?? RECEIPT_REQUIRED_STATUS, body };
      }
      return { status: 200, body: out };
    };

    const result = await receiptRequiredConformance({
      dispatch,
      tool: DANGEROUS_TOOL,
      args: {},
      // Receipt is bound to the SPECIFIC tool AND price ceiling: <action>:<tool>:<amount>
      action: `l402.pay:${DANGEROUS_TOOL}:1000`,
      issueReceipt,
      manifest: MANIFEST,
    });

    expect(result.checks.challenge_on_missing).toBe(true);
    expect(result.checks.runs_on_valid).toBe(true);
    expect(result.checks.replay_refused).toBe(true);
    expect(result.checks.forged_refused).toBe(true);
    expect(result.level).toBe("RR-1");
  });
});

describe("wrapWithReceiptGate — tool + amount binding", () => {
  function gatedHandler(toolName: string) {
    const tool = createTool(toolName);
    const inner = async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ paid: true }) }] });
    return wrapWithReceiptGate(tool, inner, {
      ...MANIFEST,
      actions: MANIFEST.actions.map((a) => ({ ...a, match: { protocol: "mcp", tool: toolName } })),
    });
  }

  test("a receipt for one price ceiling cannot authorize a larger payment", async () => {
    const wrapped = gatedHandler(DANGEROUS_TOOL);
    // Receipt minted for amount 1000 ...
    const receipt = issueReceipt(`l402.pay:${DANGEROUS_TOOL}:1000`);
    // ... presented against a 5000-sat call -> action_mismatch.
    const out = await wrapped({ [RECEIPT_ARG]: receipt, [RECEIPT_AMOUNT_ARG]: 5000 });
    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content[0].text);
    expect(body.rejected.reason).toBe("action_mismatch");
  });

  test("a receipt for tool A cannot authorize tool B (same action_type)", async () => {
    const wrappedB = gatedHandler("btc-intel_get_other_report");
    const receiptForA = issueReceipt(`l402.pay:${DANGEROUS_TOOL}:1000`);
    const out = await wrappedB({ [RECEIPT_ARG]: receiptForA, [RECEIPT_AMOUNT_ARG]: 1000 });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).rejected.reason).toBe("action_mismatch");
  });

  test("consume-after-success: a valid receipt runs once, replay refused", async () => {
    const wrapped = gatedHandler(DANGEROUS_TOOL);
    const receipt = issueReceipt(`l402.pay:${DANGEROUS_TOOL}:1000`);
    const first = await wrapped({ [RECEIPT_ARG]: receipt, [RECEIPT_AMOUNT_ARG]: 1000 });
    expect(first.isError).toBeUndefined();
    expect(first.content[0].text).toContain("Authorized by receipt");
    const replay = await wrapped({ [RECEIPT_ARG]: receipt, [RECEIPT_AMOUNT_ARG]: 1000 });
    expect(replay.isError).toBe(true);
    expect(JSON.parse(replay.content[0].text).rejected.reason).toBe("replay_refused");
  });
});

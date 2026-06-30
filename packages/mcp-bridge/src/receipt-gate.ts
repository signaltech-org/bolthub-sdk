// SPDX-License-Identifier: Apache-2.0
//
// OPT-IN "Receipt Required" gate for L402 auto-payments.
//
// By default every dynamically-registered marketplace tool auto-pays a real
// Lightning (L402) invoice with only a numeric `BUDGET_SATS` cap as a guard.
// This module lets an operator OPT IN to also requiring a verifiable
// human-authorization receipt before a tool is allowed to pay — proof a named
// human accountably approved *this exact tool at this price*.
//
//   missing receipt   -> 428 Receipt Required (refused, no payment)
//   valid receipt      -> the tool runs (and the receipt is one-time consumed)
//   replayed receipt   -> refused (one-time consumption)
//   forged/mismatched  -> refused (signature / action-binding fails)
//
// IMPORTANT — this is a no-op unless the operator opts in. With no manifest
// configured (see `loadActionManifest`), `wrapWithReceiptGate` returns the
// original handler unchanged, so behavior is byte-identical to today.
//
// The hard-to-get-right parts (target binding, consume-after-success, sanitized
// rejections) live in the reviewed gate from `@emilia-protocol/require-receipt`
// (Apache-2.0). We don't hand-roll them here.

import { readFileSync } from "node:fs";
import {
  makeReceiptGate,
  findActionRequirement,
  RECEIPT_REQUIRED_STATUS,
} from "@emilia-protocol/require-receipt";
import type { McpToolDefinition } from "./openapi-to-tools.js";

/** MCP content shape returned by a tool handler. */
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** A registered MCP tool handler: `(args) => ToolResult`. */
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * One entry in the Action Risk Manifest. Mirrors the shape the gate matches on;
 * only the fields the bridge uses are typed.
 */
interface ActionRequirement {
  match?: { protocol?: string; tool?: string };
  action_type?: string;
  receipt_required?: boolean;
  assurance_class?: string;
  max_age_sec?: number;
  /** Optional price ceiling the receipt authorizes, in sats. Binds the receipt
   *  to an amount so an approval for a cheap call can't authorize an expensive one. */
  max_amount_sats?: number;
}

interface ActionManifest {
  service?: { manifest_url?: string };
  actions?: ActionRequirement[];
}

/** Reserved arg the agent uses to present its EMILIA authorization receipt. */
export const RECEIPT_ARG = "_emilia_receipt";
/** Optional arg: the price (sats) the receipt was issued for, bound into the action. */
export const RECEIPT_AMOUNT_ARG = "_emilia_amount_sats";

/**
 * Load the operator's Action Risk Manifest, or `null` if none is configured.
 *
 * OPT-IN: the gate only activates when `BOLTHUB_AGENT_ACTIONS` points at a
 * manifest file. When unset (the default), this returns `null` and the bridge
 * registers tool handlers exactly as before — no gate, no behavior change.
 */
export function loadActionManifest(
  env: Record<string, string | undefined> = process.env,
): ActionManifest | null {
  const path = env.BOLTHUB_AGENT_ACTIONS;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ActionManifest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail loud at startup rather than silently disabling a guard the operator
    // asked for. A misconfigured guard must not degrade to "no guard".
    throw new Error(`[mcp-bridge] Failed to load BOLTHUB_AGENT_ACTIONS manifest "${path}": ${message}`);
  }
}

/** Issuer key(s) the operator trusts (comma-separated base64url SPKI). Receipts
 *  not signed by one of these are refused. Set this to enable enforcement. */
function trustedReceiptKeys(env: Record<string, string | undefined> = process.env): string[] {
  return (env.BOLTHUB_RECEIPT_TRUSTED_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
/** Explicit NON-PRODUCTION opt-in to accept self-signed (inline-key) receipts. */
function allowInlineReceiptKey(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true)$/i.test(env.BOLTHUB_RECEIPT_ALLOW_INLINE_KEY ?? "");
}

// One gate per action type (each keeps its own one-time-consumption store).
// NOTE: the default store is process-local (in-memory) — it does NOT survive a
// restart or span multiple bridge instances. For durable / multi-instance
// one-time consumption, pass a durable `store` ({ has, add }) below.
const gates = new Map<string, ReturnType<typeof makeReceiptGate>>();
function gateFor(req: ActionRequirement, manifestUrl?: string) {
  const key = req.action_type ?? req.match?.tool ?? "action";
  let gate = gates.get(key);
  if (!gate) {
    const trusted = trustedReceiptKeys();
    gate = makeReceiptGate({
      action: req.action_type ?? key,
      // Secure by default: pin the issuer key(s) you trust. Inline (self-signed)
      // keys are accepted only when the operator explicitly opts in (non-prod);
      // dispatch fails closed before reaching here if neither is configured.
      ...(trusted.length ? { trustedKeys: trusted } : { allowInlineKey: true }),
      maxAgeSec: req.max_age_sec,
      statusCode: RECEIPT_REQUIRED_STATUS,
      manifestUrl,
      assuranceClass: req.assurance_class,
      // store: pass a durable {has,add} for restart/multi-instance one-time use.
    });
    gates.set(key, gate);
  }
  return gate;
}

/** Render a gate refusal as an MCP error result (sanitized to a reason code). */
function refusalResult(status: number, body: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ status, ...(body as object) }, null, 2) }],
    isError: true,
  };
}

/**
 * Wrap a tool's payment handler so it requires a verifiable authorization
 * receipt — but ONLY when the operator's manifest marks this tool
 * `receipt_required`. Otherwise the original handler is returned unchanged.
 *
 * The receipt is bound to the exact tool AND the declared price ceiling, so an
 * approval for one tool/amount can't authorize a different tool or a larger
 * payment. The expensive side effect (`handler`, which pays the L402 invoice)
 * runs inside `gate.run`, so the receipt is consumed only on success and a
 * failed/refused call never burns a valid approval.
 */
export function wrapWithReceiptGate(
  tool: McpToolDefinition,
  handler: ToolHandler,
  manifest: ActionManifest | null,
): ToolHandler {
  if (!manifest) return handler;

  const req = findActionRequirement(manifest, {
    protocol: "mcp",
    tool: tool.name,
  }) as ActionRequirement | null;

  // Tools not listed as receipt_required pass straight through — unchanged.
  if (!req || !req.receipt_required) return handler;

  const manifestUrl = manifest.service?.manifest_url;

  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    // FAIL CLOSED: this tool is receipt_required, but no issuer key is trusted
    // and inline keys are not explicitly enabled. Refuse the payment rather than
    // accept a self-signed receipt for a real-sats L402 transaction.
    if (!trustedReceiptKeys().length && !allowInlineReceiptKey()) {
      return refusalResult(500, {
        rejected: { reason: "receipt_enforcement_misconfigured" },
        detail:
          "Set BOLTHUB_RECEIPT_TRUSTED_KEYS to the issuer key(s) you trust "
          + "(or BOLTHUB_RECEIPT_ALLOW_INLINE_KEY=1 for non-production demos). "
          + "Refusing to accept a self-signed receipt for an L402 payment.",
      });
    }

    const { [RECEIPT_ARG]: receipt, [RECEIPT_AMOUNT_ARG]: amount, ...toolArgs } = args;

    // Bind the receipt to BOTH the tool and the price ceiling it authorizes.
    // A receipt minted for `<action>:btc-intel_get_price:1000` cannot drive a
    // different tool, nor a more expensive call.
    const target = [tool.name, amount ?? req.max_amount_sats]
      .filter((v) => v !== undefined && v !== null)
      .map(String)
      .join(":");

    const r = await gateFor(req, manifestUrl).run(
      (receipt as object | undefined) ?? null,
      { target },
      async () => handler(toolArgs),
    );

    if (r.ok) {
      const result = r.result as ToolResult;
      // Append a compact, non-PII evidence line so the agent's transcript shows
      // which receipt authorized the payment. Never leak signer/subject detail
      // beyond what the receipt already carries.
      const evidence = `\n\n---\nAuthorized by receipt ${r.receiptId} (outcome: ${r.outcome})`;
      return {
        ...result,
        content: result.content.map((c, i) =>
          i === result.content.length - 1 ? { ...c, text: c.text + evidence } : c,
        ),
      };
    }
    return refusalResult(r.status, r.body);
  };
}

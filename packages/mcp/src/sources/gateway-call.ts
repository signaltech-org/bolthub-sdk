import type { McpToolDefinition } from "./openapi-to-tools.js";
import { WALLET_ENV_HINT } from "@bolthub/pay";
import type { L402Client } from "@bolthub/pay";

/** Path template segments like `/foo/{id}/bar` → ["id"]. */
export function pathPlaceholderNames(url: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(url)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function budgetSummary(l402Client: L402Client | undefined): string {
  if (!l402Client) return "";
  const spent = l402Client.totalSpent;
  const remaining = l402Client.remainingBudget;
  if (remaining === Infinity) {
    return spent > 0 ? `\n\n---\nSession spending: ${spent} sats (no budget limit)` : "";
  }
  return `\n\n---\nSession spending: ${spent} sats | Remaining budget: ${remaining} sats`;
}

/**
 * Execute an MCP tool call by sending the corresponding HTTP request
 * through the L402 client. Returns MCP-formatted text content with
 * optional cost/budget summary appended.
 *
 * Without an `l402Client` (no wallet configured) the request goes out as a
 * plain fetch: free endpoints work, and a 402 comes back as an error result
 * with the wallet setup hint.
 */
export async function executeToolCall(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  l402Client: L402Client | undefined,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const { body, ...rest } = args;

    let url = tool.meta.url;
    const remaining: Record<string, unknown> = { ...rest };

    for (const name of pathPlaceholderNames(url)) {
      const v = remaining[name];
      if (v === undefined || v === null || v === "") {
        const suffix = budgetSummary(l402Client);
        return {
          content: [{ type: "text", text: `Error: missing path parameter "${name}" for ${tool.meta.method} ${tool.meta.path}${suffix}` }],
          isError: true,
        };
      }
      const encoded = encodeURIComponent(String(v));
      url = url.split(`{${name}}`).join(encoded);
      delete remaining[name];
    }

    const queryEntries = Object.entries(remaining).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    );
    if (queryEntries.length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of queryEntries) params.set(k, String(v));
      url = `${url}?${params.toString()}`;
    }

    const fetchOptions: RequestInit = { method: tool.meta.method };
    if (body && tool.meta.method !== "GET" && tool.meta.method !== "HEAD") {
      fetchOptions.headers = { "Content-Type": "application/json" };
      fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    if (!l402Client) {
      const resp = await fetch(url, fetchOptions);
      const text = await resp.text();
      if (resp.status === 402) {
        return {
          content: [{ type: "text", text: `This endpoint requires payment and no wallet is configured.\n${WALLET_ENV_HINT}\n\nHTTP 402: ${text}` }],
          isError: true,
        };
      }
      if (!resp.ok) {
        return { content: [{ type: "text", text: `HTTP ${resp.status}: ${text}` }], isError: true };
      }
      return { content: [{ type: "text", text: prettyJson(text) }] };
    }

    // Per-request onPaid gives the EXACT cost of this call — totalSpent
    // deltas are racy when the shared budget has other concurrent spenders.
    let callCost = 0;
    const resp = await l402Client.request(url, {
      ...fetchOptions,
      onPaid: (info) => {
        callCost = info.amount;
      },
    });
    const text = await resp.text();
    const suffix = callCost > 0
      ? `\n\n---\nCost: ${callCost} sats${budgetSummary(l402Client)}`
      : budgetSummary(l402Client);

    if (!resp.ok) {
      return {
        content: [{ type: "text", text: `HTTP ${resp.status}: ${text}${suffix}` }],
        isError: true,
      };
    }

    return { content: [{ type: "text", text: prettyJson(text) + suffix }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const suffix = budgetSummary(l402Client);
    return {
      content: [{ type: "text", text: `Error: ${message}${suffix}` }],
      isError: true,
    };
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

import type { McpToolDefinition } from "./openapi-to-tools.js";
import type { L402Client } from "@bolthub/agent";

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

function budgetSummary(l402Client: L402Client): string {
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
 */
export async function executeToolCall(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  l402Client: L402Client,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const spentBefore = l402Client.totalSpent;

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

    const resp = await l402Client.request(url, fetchOptions);
    const text = await resp.text();
    const callCost = l402Client.totalSpent - spentBefore;
    const suffix = callCost > 0
      ? `\n\n---\nCost: ${callCost} sats${budgetSummary(l402Client)}`
      : budgetSummary(l402Client);

    if (!resp.ok) {
      return {
        content: [{ type: "text", text: `HTTP ${resp.status}: ${text}${suffix}` }],
        isError: true,
      };
    }

    try {
      const json = JSON.parse(text);
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) + suffix }] };
    } catch {
      return { content: [{ type: "text", text: text + suffix }] };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const suffix = budgetSummary(l402Client);
    return {
      content: [{ type: "text", text: `Error: ${message}${suffix}` }],
      isError: true,
    };
  }
}

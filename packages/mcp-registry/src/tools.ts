import type { ApiClient, DirectoryEntry } from "./api-client.js";
import type { L402Client } from "@bolthub/agent";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function budgetSummary(l402Client: L402Client): string {
  const spent = l402Client.totalSpent;
  const remaining = l402Client.remainingBudget;
  if (remaining === Infinity) {
    return spent > 0 ? `\n\n---\nSession spending: ${spent} sats (no budget limit)` : "";
  }
  return `\n\n---\nSession spending: ${spent} sats | Remaining budget: ${remaining} sats`;
}

function formatPricing(ep: {
  pricingModel: string | null;
  priceSats: number | null;
  tokenBudget: number | null;
  durationMinutes: number | null;
  unitCostSats: number | null;
}): string {
  if (!ep.priceSats) return "free";
  switch (ep.pricingModel) {
    case "per_kb":
      return `${ep.unitCostSats ?? ep.priceSats} sats/KB (${ep.priceSats} sats deposit)`;
    case "token_bucket":
      return `${ep.priceSats} sats for ${ep.tokenBudget ?? "N"} requests`;
    case "time_pass":
      return `${ep.priceSats} sats for ${ep.durationMinutes ?? "N"} min`;
    case "metered":
      return `${ep.priceSats} sats deposit, ${ep.unitCostSats ?? "N"} sats/req`;
    default:
      return `${ep.priceSats} sats/request`;
  }
}

function formatEntryCompact(entry: DirectoryEntry): string {
  const lines = [
    `${entry.name} (slug: ${entry.slug})`,
    entry.description ? `  ${entry.description}` : null,
    entry.tags.length > 0 ? `  Tags: ${entry.tags.join(", ")}` : null,
    `  Endpoints: ${entry.endpointCount}`,
  ].filter(Boolean);

  const priceRange = entry.endpoints
    .map((ep) => ep.priceSats)
    .filter((p): p is number => p !== null && p > 0);

  if (priceRange.length > 0) {
    const min = Math.min(...priceRange);
    const max = Math.max(...priceRange);
    lines.push(`  Price: ${min === max ? `${min} sats` : `${min}–${max} sats`}`);
  }

  return lines.join("\n");
}

function formatEntryDetailed(entry: DirectoryEntry, apiClient: ApiClient): string {
  const lines = [
    `# ${entry.name}`,
    "",
    entry.description ?? "",
    "",
    `Slug: ${entry.slug}`,
    `Gateway: ${apiClient.getGatewayUrl(entry.slug)}`,
    entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : "",
    "",
    "## Endpoints",
    "",
  ];

  for (const ep of entry.endpoints) {
    lines.push(`### ${ep.method} ${ep.path}`);
    if (ep.title) lines.push(`Title: ${ep.title}`);
    if (ep.description) lines.push(ep.description);
    lines.push(`Pricing: ${formatPricing(ep)}`);
    if (ep.freeTryEnabled) lines.push("Free try: available");
    if (ep.docsUrl) lines.push(`Docs: ${ep.docsUrl}`);
    if (ep.parameters && ep.parameters.length > 0) {
      lines.push("Parameters:");
      for (const p of ep.parameters) {
        const req = p.required || p.in === "path" ? "required" : "optional";
        const desc = p.description ? ` — ${p.description}` : "";
        const typ = p.type ? ` (${p.type})` : "";
        lines.push(`  - ${p.name} [${p.in}] ${req}${typ}${desc}`);
      }
    }
    if (ep.exampleRequest) {
      lines.push(`Example request: ${JSON.stringify(ep.exampleRequest)}`);
    }
    if (ep.exampleResponse) {
      lines.push(`Example response: ${JSON.stringify(ep.exampleResponse)}`);
    }
    lines.push("");
  }

  lines.push("## Usage");
  lines.push("");
  lines.push(
    'Use the call_api tool to call any endpoint above. Example: call_api({ slug: "' +
      entry.slug +
      '", path: "' +
      (entry.endpoints[0]?.path ?? "/") +
      '", method: "' +
      (entry.endpoints[0]?.method ?? "GET") +
      '" })'
  );

  return lines.filter((l) => l !== undefined).join("\n");
}

/** Handle the `search_apis` MCP tool — search the directory by keyword or tag. */
export async function handleSearchApis(
  args: { query?: string; tag?: string },
  apiClient: ApiClient,
): Promise<ToolResult> {
  try {
    const entries = await apiClient.searchApis(args.query, args.tag);

    if (entries.length === 0) {
      const hint = args.query || args.tag
        ? `No APIs found matching "${args.query ?? args.tag}". Try a broader search or omit filters to see all available APIs.`
        : "The bolthub directory is currently empty.";
      return { content: [{ type: "text", text: hint }] };
    }

    const header = `Found ${entries.length} API${entries.length === 1 ? "" : "s"}${args.query ? ` matching "${args.query}"` : ""}${args.tag ? ` tagged "${args.tag}"` : ""}:\n\n`;
    const listing = entries.map(formatEntryCompact).join("\n\n");
    const footer =
      "\n\nUse get_api_details(slug) to see full endpoint details, or call_api(slug, path, method) to make a request.";

    return { content: [{ type: "text", text: header + listing + footer }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Handle the `get_api_details` MCP tool — fetch full API info by slug. */
export async function handleGetApiDetails(
  args: { slug: string },
  apiClient: ApiClient,
): Promise<ToolResult> {
  try {
    const entry = await apiClient.getApiDetails(args.slug);
    return { content: [{ type: "text", text: formatEntryDetailed(entry, apiClient) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Handle the `preview_cost` MCP tool — show pricing without making a call. */
export async function handlePreviewCost(
  args: { slug: string; path?: string; method?: string },
  apiClient: ApiClient,
  l402Client: L402Client,
): Promise<ToolResult> {
  try {
    const entry = await apiClient.getApiDetails(args.slug);
    const method = args.method?.toUpperCase();

    const matchingEndpoints = args.path
      ? entry.endpoints.filter(
          (ep) =>
            ep.path === args.path && (!method || ep.method === method),
        )
      : entry.endpoints;

    if (matchingEndpoints.length === 0) {
      const hint = args.path
        ? `No endpoint found at ${method ?? "ANY"} ${args.path} for "${args.slug}".`
        : `No endpoints found for "${args.slug}".`;
      return { content: [{ type: "text", text: hint }] };
    }

    const lines: string[] = [`Cost preview for ${entry.name}:\n`];

    for (const ep of matchingEndpoints) {
      lines.push(`${ep.method} ${ep.path}`);
      lines.push(`  Pricing: ${formatPricing(ep)}`);
      if (ep.freeTryEnabled) lines.push("  Free try: available (one free request for signed-in users)");
      lines.push("");
    }

    const spent = l402Client.totalSpent;
    const remaining = l402Client.remainingBudget;
    if (remaining !== Infinity) {
      lines.push(`Session budget: ${spent} sats spent, ${remaining} sats remaining`);
    } else if (spent > 0) {
      lines.push(`Session spending so far: ${spent} sats (no budget limit)`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Handle the `call_api` MCP tool — call a gateway endpoint with automatic L402 payment. */
export async function handleCallApi(
  args: {
    slug: string;
    path: string;
    method?: string;
    max_cost_sats?: number;
    body?: Record<string, unknown> | string;
    query_params?: Record<string, string>;
    headers?: Record<string, string>;
  },
  apiClient: ApiClient,
  l402Client: L402Client,
): Promise<ToolResult> {
  const spentBefore = l402Client.totalSpent;

  try {
    const method = (args.method ?? "GET").toUpperCase();
    let url = apiClient.getGatewayUrl(args.slug, args.path);

    if (args.query_params && Object.keys(args.query_params).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args.query_params)) {
        params.set(k, v);
      }
      url = `${url}?${params.toString()}`;
    }

    const fetchOptions: RequestInit = { method };
    const reqHeaders: Record<string, string> = { ...(args.headers ?? {}) };

    if (args.body && method !== "GET" && method !== "HEAD") {
      reqHeaders["Content-Type"] = "application/json";
      fetchOptions.body =
        typeof args.body === "string" ? args.body : JSON.stringify(args.body);
    }

    if (Object.keys(reqHeaders).length > 0) {
      fetchOptions.headers = reqHeaders;
    }

    if (args.max_cost_sats && args.max_cost_sats > 0) {
      const originalRequest = l402Client.request.bind(l402Client);
      const maxCost = args.max_cost_sats;

      const resp = await originalRequest(url, fetchOptions).catch((err: unknown) => {
        if (err instanceof Error && err.name === "L402BudgetError") {
          throw new Error(`Invoice exceeds max_cost_sats limit of ${maxCost} sats. ${err.message}`);
        }
        throw err;
      });

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
    const suffix = budgetSummary(l402Client);
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}${suffix}` }],
      isError: true,
    };
  }
}

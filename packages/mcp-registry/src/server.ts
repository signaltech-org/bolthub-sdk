import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import type { ApiClient } from "./api-client.js";
import type { L402Client } from "@bolthub/agent";
import { handleSearchApis, handleGetApiDetails, handleCallApi, handlePreviewCost } from "./tools.js";
import { handleDeployNode, handleNodeStatus } from "./node-tools.js";

/**
 * Register the six registry tools and start the stdio-based MCP server.
 * Blocks until the transport disconnects.
 */
export async function startRegistryServer(
  apiClient: ApiClient,
  l402Client: L402Client,
): Promise<void> {
  // Source the version from package.json so `serverInfo.version` reported
  // to MCP clients never drifts from the published npm version. Bun's
  // bundler inlines this JSON import at build time, so the published
  // dist has the version baked in — no runtime fs read needed.
  const server = new McpServer({
    name: "bolthub-registry",
    version: pkg.version,
  });

  server.tool(
    "search_apis",
    "Search the bolthub API marketplace. Returns a list of available APIs with names, descriptions, tags, endpoint counts, and pricing. Use this to discover APIs that match your needs. Call without arguments to list all available APIs.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Search query — matches API names, descriptions, tags, and endpoint paths"
        ),
      tag: z
        .string()
        .optional()
        .describe(
          "Filter by tag (e.g. 'weather', 'finance', 'ai'). Use search_apis() with no args to see all available tags."
        ),
    },
    async (args) => handleSearchApis(args, apiClient),
  );

  server.tool(
    "get_api_details",
    "Get full details for a specific API including all endpoints, pricing, example requests/responses, and usage instructions. Use the slug from search_apis results.",
    {
      slug: z.string().describe("The API slug from search_apis results (e.g. 'pokemon', 'weather')"),
    },
    async (args) => handleGetApiDetails(args, apiClient),
  );

  server.tool(
    "preview_cost",
    "Preview the cost of calling an API endpoint without making the actual request or paying. Use this to check pricing before committing to a call.",
    {
      slug: z.string().describe("The API slug (e.g. 'pokemon')"),
      path: z.string().optional().describe("Specific endpoint path to check. If omitted, shows pricing for all endpoints."),
      method: z.string().optional().describe("HTTP method — defaults to GET"),
    },
    async (args) => handlePreviewCost(args, apiClient, l402Client),
  );

  server.tool(
    "call_api",
    "Call an API endpoint on the bolthub marketplace. Handles L402 Lightning payments automatically. Use get_api_details or preview_cost first to check pricing. Returns the response along with cost and budget information.",
    {
      slug: z.string().describe("The API slug (e.g. 'pokemon')"),
      path: z.string().describe("The endpoint path (e.g. '/v2/pokemon/pikachu')"),
      method: z
        .string()
        .optional()
        .describe("HTTP method — defaults to GET"),
      max_cost_sats: z
        .number()
        .optional()
        .describe("Maximum sats to pay for this request. If the invoice exceeds this amount, the call is refused. Overrides the session budget for this single call."),
      body: z
        .record(z.unknown())
        .optional()
        .describe("JSON request body for POST/PUT/PATCH requests"),
      query_params: z
        .record(z.string())
        .optional()
        .describe("Query parameters as key-value pairs"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Additional HTTP headers"),
    },
    async (args) => handleCallApi(args, apiClient, l402Client),
  );

  const apiBaseUrl = (apiClient as unknown as { apiUrl?: string }).apiUrl ?? "https://api.bolthub.ai";
  const authToken = process.env.BOLTHUB_AUTH_TOKEN;

  server.tool(
    "deploy_node",
    "Deploy a new Lightning node (LND + Neutrino) on a VPS. The node runs on the user's own server and is fully non-custodial. Returns a node ID to track progress. The user must complete wallet setup manually in the Lightning Terminal UI. Use node_status to check progress.",
    {
      provider: z
        .enum(["hetzner", "digitalocean", "lunanode", "vultr", "scaleway"])
        .describe("VPS provider. LunaNode is cheapest (~$3.50/mo) and accepts BTC, Hetzner ~$5.49/mo, Scaleway ~$6.42/mo, Vultr ~$10/mo (32 locations + accepts crypto), DigitalOcean ~$12/mo (global)."),
      api_key: z.string().describe("VPS provider API key (e.g., Hetzner API token)"),
      region: z
        .string()
        .optional()
        .describe("Region slug (e.g., 'nbg1', 'fsn1'). Omit to use the first available region."),
      tor: z
        .boolean()
        .optional()
        .describe("Enable Tor-only mode for maximum privacy. Default: false."),
    },
    async (args) => handleDeployNode(args, apiBaseUrl, authToken),
  );

  server.tool(
    "node_status",
    "Check the status of a deployed Lightning node. Returns current state, IP address, sync progress, and setup instructions when applicable.",
    {
      node_id: z.string().describe("Node ID returned by deploy_node"),
    },
    async (args) => handleNodeStatus(args, apiBaseUrl, authToken),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * MarketplaceSource — the bolthub directory meta-tools (the old
 * `@bolthub/mcp-registry`, as a source): discover → preview → call any
 * listed API. The marketplace meta-tools are exposed UNPREFIXED even in prefix
 * mode — they are the server's native surface and their descriptions
 * cross-reference each other by bare name. (Per-endpoint tools for the whole
 * directory would
 * blow client tool limits; the meta-tool flow is deliberate.)
 *
 * Schemas are plain JSON Schema (the unified server forwards schemas raw;
 * nothing here needs zod at runtime).
 */

import { ApiClient } from "./api-client.js";
import {
  handleSearchApis,
  handleGetApiDetails,
  handlePreviewCost,
  handleCallApi,
  handleBuyBundle,
  handleMintScopedToken,
  handleRevokeToken,
} from "./marketplace-tools.js";
import { handleDeployNode, handleNodeStatus } from "./node-tools.js";
import type { SourceTool, ToolSource } from "./source.js";
import type { PaymentServices } from "../payment.js";
import type { ToolResult } from "@bolthub/pay";

const TOOLS: SourceTool[] = [
  {
    name: "search_apis",
    description:
      "Search the bolthub API marketplace. Returns a list of available APIs with names, descriptions, tags, endpoint counts, and pricing. Use this to discover APIs that match your needs. Call without arguments to list all available APIs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — matches API names, descriptions, tags, and endpoint paths",
        },
        tag: {
          type: "string",
          description:
            "Filter by tag (e.g. 'weather', 'finance', 'ai'). Use search_apis() with no args to see all available tags.",
        },
      },
    },
  },
  {
    name: "get_api_details",
    description:
      "Get full details for a specific API including all endpoints, pricing, example requests/responses, and usage instructions. Use the slug from search_apis results.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The API slug from search_apis results (e.g. 'btc-intel')" },
      },
      required: ["slug"],
    },
  },
  {
    name: "preview_cost",
    description:
      "Preview the cost of calling an API endpoint without making the actual request or paying. Use this to check pricing before committing to a call.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The API slug (e.g. 'btc-intel')" },
        path: {
          type: "string",
          description: "Specific endpoint path to check. If omitted, shows pricing for all endpoints.",
        },
        method: { type: "string", description: "HTTP method — defaults to GET" },
      },
      required: ["slug"],
    },
  },
  {
    name: "call_api",
    description:
      "Call an API endpoint on the bolthub marketplace. Handles L402 Lightning payments automatically. Use get_api_details or preview_cost first to check pricing. Returns the response along with cost and budget information.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The API slug (e.g. 'btc-intel')" },
        path: { type: "string", description: "The endpoint path (e.g. '/v1/history/candles')" },
        method: { type: "string", description: "HTTP method — defaults to GET" },
        max_cost_sats: {
          type: "number",
          description:
            "Maximum sats to pay for this request. If the invoice exceeds this amount, the call is refused and nothing is paid.",
        },
        body: { type: "object", description: "JSON request body for POST/PUT/PATCH requests" },
        query_params: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Query parameters as key-value pairs",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Additional HTTP headers",
        },
      },
      required: ["slug", "path"],
    },
  },
  {
    name: "buy_bundle",
    description:
      "Buy a prepaid bundle for a bolthub API endpoint: pay ONCE for a set number of requests, then call_api uses them with no further Lightning payment until the bundle runs out. Amortizes the 1–3s payment latency across many calls — worthwhile when you'll make many requests to the same endpoint. Only endpoints the seller has enabled for bundles accept this; the error names the available sizes if the one you ask for isn't offered.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The API slug (e.g. 'btc-intel')" },
        path: { type: "string", description: "The endpoint path the bundle is for (e.g. '/v1/history/candles')" },
        uses: { type: "number", description: "Number of requests to buy (must match a size the endpoint offers)" },
        max_cost_sats: {
          type: "number",
          description: "Maximum sats to pay for the bundle. If the bundle price exceeds this, the purchase is refused and nothing is paid.",
        },
      },
      required: ["slug", "path", "uses"],
    },
  },
  {
    name: "mint_scoped_token",
    description:
      "Mint a scoped, capped child credential from a prepaid bundle you already hold for an endpoint, to hand to a sub-agent. Attenuates OFFLINE (no payment, no round-trip): the child is a normal L402 token the worker spends with call_api or a plain client, and the gateway enforces every cap. Attenuation is tighten-only — a child can never widen scope or exceed the parent's remaining uses/sats. Give at least one restriction. Requires buy_bundle for this endpoint first (a single-use payment has nothing to delegate). Revoke the whole tree with revoke_token.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The API slug the credential is for (e.g. 'btc-intel')" },
        path: { type: "string", description: "The endpoint path the held bundle is for (e.g. '/v1/history/candles')" },
        n_uses: { type: "number", description: "Cap the child to this many requests (must not exceed the parent's remaining n_uses)" },
        spend_cap_sats: { type: "number", description: "Cap the child's cumulative spend in sats (must not exceed the parent's max_sats)" },
        path_prefix: { type: "string", description: "Restrict the child to request paths at or under this prefix (must be at or under the parent's path scope)" },
        expiry: { type: "string", description: "Child expiry as an ISO 8601 timestamp (e.g. '2026-08-01T00:00:00Z') or Unix milliseconds; must be no later than the parent's expiry" },
      },
      required: ["slug", "path"],
    },
  },
  {
    name: "revoke_token",
    description:
      "Revoke the grant behind a prepaid bundle this session bought, killing the whole delegation tree minted from it (every scoped child made with mint_scoped_token). Takes effect on the next request within ~15s, returning token_revoked. Use it to cut off a sub-agent (or all of them) after handing out children. Optionally pass released_sats to return child-cap budget you reserved back to your budget.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The API slug whose bundle grant you want to revoke (e.g. 'btc-intel')" },
        path: { type: "string", description: "The endpoint path the held bundle is for (e.g. '/v1/history/candles')" },
        released_sats: { type: "number", description: "Optional: sats of child-cap budget to return to your budget (what you reserved via mint_scoped_token for children of this grant)" },
      },
      required: ["slug", "path"],
    },
  },
  {
    name: "deploy_node",
    description:
      "Deploy a new Lightning node (LND + Neutrino) on a VPS. The node runs on the user's own server and is fully non-custodial. Returns a node ID to track progress. The user must complete wallet setup manually in the Lightning Terminal UI. Use node_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["hetzner", "digitalocean", "lunanode", "vultr", "scaleway"],
          description:
            "VPS provider. LunaNode is cheapest (~$3.50/mo) and accepts BTC, Hetzner ~$5.49/mo, Scaleway ~$6.42/mo, Vultr ~$10/mo (32 locations + accepts crypto), DigitalOcean ~$12/mo (global).",
        },
        api_key: { type: "string", description: "VPS provider API key (e.g., Hetzner API token)" },
        region: {
          type: "string",
          description: "Region slug (e.g., 'nbg1', 'fsn1'). Omit to use the first available region.",
        },
        tor: {
          type: "boolean",
          description: "Enable Tor-only mode for maximum privacy. Default: false.",
        },
      },
      required: ["provider", "api_key"],
    },
  },
  {
    name: "node_status",
    description:
      "Check the status of a deployed Lightning node. Returns current state, IP address, sync progress, and setup instructions when applicable.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node ID returned by deploy_node" },
      },
      required: ["node_id"],
    },
  },
];

export class MarketplaceSource implements ToolSource {
  readonly kind = "marketplace" as const;
  readonly namespaced = false;
  readonly key = "marketplace";
  private readonly apiClient: ApiClient;
  private readonly apiUrl?: string;
  private readonly services: PaymentServices;

  constructor(options: { apiUrl?: string }, services: PaymentServices) {
    this.apiUrl = options.apiUrl;
    this.apiClient = new ApiClient(options.apiUrl);
    this.services = services;
  }

  async init(): Promise<void> {
    // No upfront work: the directory is queried per tool call, and being
    // temporarily unreachable at startup should not drop the source.
  }

  listTools(): SourceTool[] {
    return TOOLS;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const l402Client = this.services.l402Client;
    switch (name) {
      case "search_apis":
        return handleSearchApis(args as { query?: string; tag?: string }, this.apiClient);
      case "get_api_details":
        return handleGetApiDetails(args as { slug: string }, this.apiClient);
      case "preview_cost":
        return handlePreviewCost(
          args as { slug: string; path?: string; method?: string },
          this.apiClient,
          l402Client,
        );
      case "call_api":
        return handleCallApi(
          args as Parameters<typeof handleCallApi>[0],
          this.apiClient,
          l402Client,
        );
      case "buy_bundle":
        return handleBuyBundle(
          args as Parameters<typeof handleBuyBundle>[0],
          this.apiClient,
          l402Client,
        );
      case "mint_scoped_token":
        return handleMintScopedToken(
          args as Parameters<typeof handleMintScopedToken>[0],
          this.apiClient,
          l402Client,
        );
      case "revoke_token":
        return handleRevokeToken(
          args as Parameters<typeof handleRevokeToken>[0],
          this.apiClient,
          l402Client,
        );
      case "deploy_node":
        return handleDeployNode(
          args as Parameters<typeof handleDeployNode>[0],
          this.apiUrl,
          process.env.BOLTHUB_AUTH_TOKEN,
        );
      case "node_status":
        return handleNodeStatus(
          args as Parameters<typeof handleNodeStatus>[0],
          this.apiUrl,
          process.env.BOLTHUB_AUTH_TOKEN,
        );
      default:
        throw new Error(`Unknown marketplace tool "${name}"`);
    }
  }

  async close(): Promise<void> {
    // Stateless.
  }
}

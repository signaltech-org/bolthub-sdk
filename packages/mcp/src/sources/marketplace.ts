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
  handleBuyCredit,
  handleMintScopedToken,
  handleRevokeToken,
} from "./marketplace-tools.js";
import { handleDeployNode, handleNodeStatus } from "./node-tools.js";
import { handleListApi, handlePublishListing, resolveAccountToken } from "./seller-tools.js";
import { handleAnalyzeListing } from "./analyze-tools.js";
import { handleGetEarnings, handleUsageSummary } from "./revenue-tools.js";
import { handleConnectAccount, handleConnectStatus } from "./connect-tools.js";
import {
  handleCreateWorkspace,
  handleConnectWallet,
  handleGetOnboardingState,
} from "./onboarding-tools.js";
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
    name: "buy_credit",
    description:
      "Buy prepaid CREDIT for a bolthub provider: pay ONCE for a sats budget spendable across ALL of that provider's endpoints, then call_api to any of them draws the credit with no further Lightning payment until it runs out. Use this when you'll call SEVERAL of one provider's endpoints — sum their costs and buy that much credit in one payment. Credit is face-value (the provider charges exactly the sats you ask for, no discount tiers) and per-provider: it never covers a different provider (you'd buy separate credit for each). Unused credit at expiry is non-refundable, so size it to what you expect to spend.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The provider's API slug (e.g. 'btc-intel')" },
        path: { type: "string", description: "Any endpoint path of the provider to buy against (e.g. '/v1/history/candles'); the credit covers all of the provider's endpoints" },
        credit_sats: { type: "number", description: "Amount of credit to buy in sats (charged at face value)" },
        max_cost_sats: {
          type: "number",
          description: "Maximum sats to pay for the credit. If the price exceeds this, the purchase is refused and nothing is paid.",
        },
      },
      required: ["slug", "path", "credit_sats"],
    },
  },
  {
    name: "mint_scoped_token",
    description:
      "Mint a scoped, capped child credential from a multi-use credential you already hold for an endpoint, to hand to a sub-agent. Attenuates OFFLINE (no payment, no round-trip): the child is a normal L402 token the worker spends with call_api or a plain client, and the gateway enforces every cap. Attenuation is tighten-only — a child can never widen scope or exceed the parent's remaining uses/sats. Give at least one restriction. Requires a held multi-use credential for this endpoint (a single-use payment has nothing to delegate). Revoke the whole tree with revoke_token.",
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
      "Deploy a Lightning node (LND + Neutrino) on the user's own VPS — fully non-custodial. GUIDED FLOW, call it repeatedly as the conversation progresses: (1) no arguments → provider menu with prices; (2) provider chosen but no credential stored → sign-up + access-token steps for that provider (the token itself is entered at bolthub.ai/nodes/deploy in the browser, never in chat); (3) credential present → region menu; (4) region → server sizes with monthly prices; (5) region + size (or size 'recommended') → deploys and returns the node id. The user then creates the wallet + seed phrase on their own node page; bind it as the payout wallet afterwards with connect_wallet.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["hetzner", "digitalocean", "lunanode", "vultr", "scaleway"],
          description: "Chosen provider. Omit to get the provider menu with prices.",
        },
        credential_id: {
          type: "string",
          description: "Stored VPS credential id. Omit when the account has exactly one (it's used automatically); the tool lists them when there are several.",
        },
        region: {
          type: "string",
          description: "Region slug from the region menu step.",
        },
        size: {
          type: "string",
          description: "Server size slug from the sizes step, or 'recommended' for the cheapest (a Lightning node runs fine on it). Deploy starts only when both region and size are given.",
        },
        api_key: {
          type: "string",
          description: "DEPRECATED: passing a VPS key here puts it into chat context, and agent sessions can't store keys anyway. The tool walks the user through adding it at bolthub.ai/nodes/deploy instead.",
        },
        tor: {
          type: "boolean",
          description: "Enable Tor-only mode for maximum privacy. Default: false.",
        },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "node_status",
    description:
      "Check the status of a deployed Lightning node. Returns current state, IP address, sync progress, and setup instructions when applicable. Pass wait_for to BLOCK until a milestone is reached (for driving deploy → wallet → bind without babysitting): the call polls server-side state and returns as soon as the condition holds, errors loudly on timeout or a terminal state, and stops immediately when only user action can progress things (wallet creation is a browser step). Never wrap this tool in your own polling loop — use wait_for.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node ID returned by deploy_node" },
        wait_for: {
          type: "string",
          enum: ["wallet_pending", "ready", "payable"],
          description:
            "Block until: wallet_pending = VPS up, LND waiting for its wallet (next step is the user's seed ceremony); ready = wallet created and macaroon minted; payable = ready AND an active channel with inbound capacity (what a settlement test needs). A node already past the milestone returns immediately.",
        },
        timeout_s: {
          type: "number",
          description: "Hard wait ceiling in seconds, 5-600 (default 120). On timeout the tool errors with what to do next; it never silently keeps polling.",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "list_api",
    description:
      "Turn an API spec into a DRAFT bolthub listing: parses OpenAPI/Swagger or Postman (JSON or YAML), creates the endpoints as unlisted drafts (never visible in the directory), and applies a default per-request price you can refine. Publishing is a separate explicit step — use publish_listing. Requires BOLTHUB_ACCOUNT_TOKEN (your bolthub account, dashboard → MCP setup). Re-importing a spec for an origin that already has endpoints shows a dry-run diff instead of duplicating anything.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: {
          type: "string",
          description: "Workspace id to list into. Omit when the account has exactly one workspace; with several, the tool lists them so the user can pick.",
        },
        spec_url: {
          type: "string",
          description: "URL of the spec. Fetched server-side through bolthub's SSRF-safe proxy — never directly.",
        },
        spec_content: {
          type: "string",
          description:
            'Inline spec instead of a URL: OpenAPI/Swagger/Postman JSON or YAML, or a plain JSON array of rows like [{"method":"GET","path":"/v1/x","title":"...","description":"..."}] for manual assembly from a conversation.',
        },
        origin_url: {
          type: "string",
          description: "Base URL of the upstream API (e.g. https://api.example.com). Required when the spec declares no servers/base URL; overrides it when it does.",
        },
        price_sats: {
          type: "number",
          description: "Per-request price in sats applied to the draft (default 5, minimum 1). Per-endpoint refinement happens in the dashboard before publishing.",
        },
        apply_sync: {
          type: "boolean",
          description: "Re-import only: after reviewing the dry-run diff from a previous call, set true to apply it. Sync updates spec-owned fields only and never touches pricing.",
        },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "publish_listing",
    description:
      "Take a workspace's draft endpoints live in the bolthub directory. Without confirm:true it is a DRY RUN that shows exactly what would go live (endpoints, prices, workspace activation) — show that to the user and get their go-ahead before re-calling with confirm:true. Publishing the first endpoint starts the workspace's 30-day free trial. Requires BOLTHUB_ACCOUNT_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: {
          type: "string",
          description: "Workspace id. Omit when the account has exactly one workspace.",
        },
        endpoint_ids: {
          type: "array",
          items: { type: "string" },
          description: "Specific endpoint ids to publish. Omit to publish every unlisted endpoint in the workspace.",
        },
        confirm: {
          type: "boolean",
          description: "Omitted/false = dry run (no changes). true = publish exactly what the dry run showed.",
        },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "analyze_listing",
    description:
      "Audit a bolthub listing you own against the seller-guide rubric and get a prioritized punch list (HIGH/MED/LOW findings with evidence and a fix pointer). Checks origin protection (is the paywall bypassable? is bolthub's signed traffic being rejected?), honest status codes, docs/examples quality, public schema visibility, uptime and p95 latency, pricing-model fit, samples, and free-try. Read-only — changes nothing. Useful before publish_listing and any time revenue looks off. Requires BOLTHUB_ACCOUNT_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: {
          type: "string",
          description: "Workspace id. Omit when the account has exactly one workspace.",
        },
        endpoint_id: {
          type: "string",
          description: "Audit a single endpoint instead of the whole listing.",
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_earnings",
    description:
      "Revenue report for a bolthub workspace you own: all-time and windowed earnings in sats, recent paid days, and top-earning endpoints. Read-only. Requires BOLTHUB_ACCOUNT_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: {
          type: "string",
          description: "Workspace id. Omit when the account has exactly one workspace.",
        },
        days: {
          type: "number",
          description: "Reporting window in days for the recent-revenue figures (default 30, max 365). All-time totals are always included.",
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "usage_summary",
    description:
      "Operational usage for a bolthub workspace you own: billing status and projected platform fee for the current cycle, paid traffic by endpoint, and SDK-tool (facilitator) usage. Pass endpoint_id for one endpoint's latency/error detail. Read-only. Requires BOLTHUB_ACCOUNT_TOKEN.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: {
          type: "string",
          description: "Workspace id. Omit when the account has exactly one workspace.",
        },
        endpoint_id: {
          type: "string",
          description: "Drill into one endpoint: request count, success rate, avg/p95 latency, error breakdown.",
        },
        days: {
          type: "number",
          description: "Window for SDK-tool usage figures (default 30, max 365).",
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "connect_account",
    description:
      "One-click connect this MCP server to the user's bolthub account. Starts a browser pairing: returns an approval link and a short confirmation code — show BOTH to the user and tell them to check the codes match before approving. After they approve, call connect_status to finish. The minted account token is stored locally and never appears in chat. Use when a seller tool reports no account token.",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Name shown on the approval page and in the dashboard token list. Defaults to 'Claude Desktop on <hostname>'.",
        },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "connect_status",
    description:
      "Finish or check the account pairing started by connect_account. Call it after the user says they approved in the browser. On success the account token is stored locally (never shown in chat) and the seller tools start working.",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "create_workspace",
    description:
      "Create a new bolthub workspace (tenant) for selling APIs. Secret-free and reversible: an empty workspace costs nothing and the 30-day trial only starts when a first endpoint is published. Wallet connection is a separate step (connect_wallet). Requires an account token (connect_account).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workspace display name." },
        slug: {
          type: "string",
          description: "URL slug (lowercase letters, digits, hyphens; 3-63 chars). Omit to derive from the name; taken slugs get a numbered variant automatically.",
        },
        description: { type: "string", description: "Optional workspace description shown in the directory." },
        tags: { type: "array", items: { type: "string" }, description: "Optional directory tags (max 10)." },
      },
      required: ["name"],
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "connect_wallet",
    description:
      "Check or set up the payout wallet for a workspace. A deployed bolthub node can be bound directly (pass node_id — the credential copy is server-side, nothing secret enters chat). Other wallets connect in the browser: the tool returns the dashboard link plus guidance for self-hosted LND (invoice-only macaroon) and always-on NWC services; the chat only ever sees connected yes/no and reachability. Re-run after the user connects to confirm. Non-custodial: sats settle directly to the user's wallet.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string", description: "Workspace id. Omit when the account has exactly one workspace." },
        node_id: {
          type: "string",
          description: "Bind this deployed bolthub node as the payout wallet (from deploy_node/node_status, or the list this tool shows). Server-side credential copy; changes where payouts land.",
        },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "get_onboarding_state",
    description:
      "One-look onboarding checklist for a workspace: wallet connected, endpoints drafted/published, origin-protection verdict (live probe), listing live, trial state — plus the single next step. Use it to drive the seller onboarding conversation. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string", description: "Workspace id. Omit when the account has exactly one workspace." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      case "buy_credit":
        return handleBuyCredit(
          args as Parameters<typeof handleBuyCredit>[0],
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
          resolveAccountToken(),
        );
      case "node_status":
        return handleNodeStatus(
          args as Parameters<typeof handleNodeStatus>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "list_api":
        return handleListApi(
          args as Parameters<typeof handleListApi>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "publish_listing":
        return handlePublishListing(
          args as Parameters<typeof handlePublishListing>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "analyze_listing":
        return handleAnalyzeListing(
          args as Parameters<typeof handleAnalyzeListing>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "get_earnings":
        return handleGetEarnings(
          args as Parameters<typeof handleGetEarnings>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "usage_summary":
        return handleUsageSummary(
          args as Parameters<typeof handleUsageSummary>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "connect_account":
        return handleConnectAccount(
          args as Parameters<typeof handleConnectAccount>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "connect_status":
        return handleConnectStatus({}, this.apiUrl, resolveAccountToken());
      case "create_workspace":
        return handleCreateWorkspace(
          args as Parameters<typeof handleCreateWorkspace>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "connect_wallet":
        return handleConnectWallet(
          args as Parameters<typeof handleConnectWallet>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      case "get_onboarding_state":
        return handleGetOnboardingState(
          args as Parameters<typeof handleGetOnboardingState>[0],
          this.apiUrl,
          resolveAccountToken(),
        );
      default:
        throw new Error(`Unknown marketplace tool "${name}"`);
    }
  }

  async close(): Promise<void> {
    // Stateless.
  }
}

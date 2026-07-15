import { SITE_URL } from "@bolthub/shared";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_API_URL = "https://api.bolthub.ai";

function errorText(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

interface StoredCredential {
  id: string;
  provider: string;
  label: string | null;
  apiKeyMasked: string;
}

const credentialLine = (c: StoredCredential) =>
  `  ${c.id}  ${c.provider}${c.label ? ` (${c.label})` : ""} ${c.apiKeyMasked}`;

/**
 * Static provider catalog for the conversational spin-up flow. Everything
 * here is public, non-secret guidance: prices are "from" figures matching
 * the marketing/site copy, and the token steps tell the user where in each
 * provider console to mint an API key — which is then entered ONLY at the
 * dashboard deploy page, never in chat.
 */
export const VPS_PROVIDERS: Array<{
  slug: string;
  name: string;
  priceFrom: string;
  note: string;
  tokenSteps: string[];
}> = [
  {
    slug: "lunanode",
    name: "LunaNode",
    priceFrom: "~$3.50/mo",
    note: "cheapest; Bitcoin-friendly, accepts BTC",
    tokenSteps: [
      "Sign up at lunanode.com (accepts BTC).",
      "Console → API (dynamic.lunanode.com/panel/api) → create an API key pair.",
    ],
  },
  {
    slug: "hetzner",
    name: "Hetzner Cloud",
    priceFrom: "~$5.49/mo",
    note: "EU data centers, also US East + Singapore",
    tokenSteps: [
      "Sign up at hetzner.com/cloud and create a project.",
      "Project → Security → API tokens → Generate (Read & Write).",
    ],
  },
  {
    slug: "scaleway",
    name: "Scaleway",
    priceFrom: "~$6.42/mo",
    note: "EU data centers (Paris, Amsterdam, Warsaw)",
    tokenSteps: [
      "Sign up at scaleway.com.",
      "Console → IAM → API keys → Generate API key (copy the secret key).",
    ],
  },
  {
    slug: "vultr",
    name: "Vultr",
    priceFrom: "~$10/mo",
    note: "32 global locations, accepts crypto",
    tokenSteps: [
      "Sign up at vultr.com (accepts crypto).",
      "my.vultr.com → Account → API → enable Personal Access Token. If you use their IP allowlist, allow all (bolthub deploys from cloud IPs).",
    ],
  },
  {
    slug: "digitalocean",
    name: "DigitalOcean",
    priceFrom: "~$12/mo",
    note: "global coverage",
    tokenSteps: [
      "Sign up at digitalocean.com.",
      "cloud.digitalocean.com → API → Generate New Token (write scope).",
    ],
  },
];

function providerMenu(): string {
  return [
    "Pick a VPS provider for your Lightning node (your server, your keys — bolthub never holds funds):",
    "",
    ...VPS_PROVIDERS.map((p) => `  ${p.slug.padEnd(13)} ${p.name} — from ${p.priceFrom} (${p.note})`),
    "",
    "Say which one and I'll walk you through getting its access token.",
  ].join("\n");
}

/**
 * The provider/price menu, annotated with which providers already have a
 * stored credential (L4: a returning user with several credentials must
 * still get the price comparison before being asked to pick an opaque
 * credential id). Providers seen only in stored credentials (retired from
 * the static catalog) are appended so their credentials stay reachable.
 */
function providerMenuWithStored(credentials: StoredCredential[]): string {
  const byProvider = new Map<string, number>();
  for (const c of credentials) {
    byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
  }
  const storedMark = (slug: string): string => {
    const n = byProvider.get(slug);
    return n ? ` [${n} stored credential${n > 1 ? "s" : ""}]` : "";
  };
  const catalogSlugs = new Set(VPS_PROVIDERS.map((p) => p.slug));
  const extras = [...byProvider.keys()].filter((slug) => !catalogSlugs.has(slug));
  return [
    "Pick a VPS provider first (prices for comparison; your server, your keys — bolthub never holds funds):",
    "",
    ...VPS_PROVIDERS.map(
      (p) => `  ${p.slug.padEnd(13)} ${p.name} — from ${p.priceFrom} (${p.note})${storedMark(p.slug)}`,
    ),
    ...extras.map((slug) => `  ${slug.padEnd(13)} (stored credential only)${storedMark(slug)}`),
    "",
    "Re-run deploy_node with provider set. A provider with one stored credential deploys with it automatically; with several I'll list them to pick by credential_id.",
  ].join("\n");
}

function providerTokenGuide(slug: string): string | null {
  const p = VPS_PROVIDERS.find((x) => x.slug === slug);
  if (!p) return null;
  return [
    `${p.name} setup — two steps, then we deploy:`,
    "",
    ...p.tokenSteps.map((s, i) => `  ${i + 1}. ${s}`),
    `  ${p.tokenSteps.length + 1}. Add the token at ${SITE_URL}/nodes/deploy — it's a secret, so it's entered in the browser and never in this chat.`,
    "",
    `When that's done, tell me and I'll re-run deploy_node with provider "${p.slug}" — it picks up the stored credential automatically and we choose a region next.`,
  ].join("\n");
}

export async function handleDeployNode(
  args: {
    provider?: string;
    /** Deprecated (onboarding-v2 D7): puts the VPS key into chat context. */
    api_key?: string;
    credential_id?: string;
    region?: string;
    /** Size slug from the sizes step, or "recommended" for the cheapest. */
    size?: string;
    tor?: boolean;
  },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;

  try {
    let credId: string;
    let deprecationNote = "";

    if (args.credential_id) {
      credId = args.credential_id;
    } else if (args.api_key && args.provider) {
      // Deprecated path: the key just transited the chat/model context.
      // PAT-authed sessions can't use it at all (the API's D4 deny-list
      // rejects VPS-credential creation outside a browser session).
      deprecationNote =
        "WARNING: passing api_key here puts your VPS key into the chat. Next time add it once at " +
        `https://bolthub.ai/nodes/deploy and deploy with the stored credential instead.\n\n`;
      try {
        const credResult = await apiRequest<{
          credential: { id: string };
        }>(baseUrl, "/vps-credentials", {
          method: "POST",
          body: { provider: args.provider, apiKey: args.api_key, label: "MCP-created" },
          token: authToken,
        });
        credId = credResult.credential.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/browser session/i.test(message)) {
          return errorText(
            "VPS keys can't be added from an agent session (they're secrets). Add the key once at https://bolthub.ai/nodes/deploy in the browser, then re-run deploy_node — it will use the stored credential automatically.",
          );
        }
        throw err;
      }
    } else {
      // Preferred path: deploy from a credential stored via the dashboard.
      const { credentials } = await apiRequest<{ credentials: StoredCredential[] }>(
        baseUrl,
        "/vps-credentials",
        { token: authToken },
      );
      const matching = args.provider
        ? credentials.filter((c) => c.provider === args.provider)
        : credentials;
      if (matching.length === 0) {
        // Conversational spin-up: no credential yet. Without a provider,
        // present the menu; with one, walk through minting its token.
        if (!args.provider) {
          return { content: [{ type: "text", text: providerMenu() }] };
        }
        const guide = providerTokenGuide(args.provider);
        if (!guide) {
          return errorText(
            `Unknown provider "${args.provider}". ${providerMenu()}`,
          );
        }
        return { content: [{ type: "text", text: guide }] };
      }
      if (matching.length > 1) {
        // Provider unset: pick the provider (with prices) before asking the
        // user to choose between opaque credential ids (L4). Provider set:
        // disambiguate its credentials.
        if (!args.provider) {
          return { content: [{ type: "text", text: providerMenuWithStored(credentials) }] };
        }
        return errorText(
          [
            `Several stored credentials for ${args.provider} — re-run with credential_id set to one of:`,
            ...matching.map(credentialLine),
          ].join("\n"),
        );
      }
      credId = matching[0].id;
      deprecationNote = `Using stored credential: ${matching[0].provider}${matching[0].label ? ` (${matching[0].label})` : ""}.\n\n`;
    }

    const regionsResult = await apiRequest<{
      regions: Array<{ slug: string; name: string }>;
    }>(baseUrl, `/vps-credentials/${credId}/regions`, { token: authToken });
    if (regionsResult.regions.length === 0) {
      return errorText("No regions available for this provider.");
    }

    // Stepwise selection: the node is a paid resource on the user's own
    // account, so region and size are the user's calls, never auto-picked.
    if (!args.region || !regionsResult.regions.some((r) => r.slug === args.region)) {
      return {
        content: [
          {
            type: "text",
            text: [
              args.region ? `Region "${args.region}" isn't available. Pick one of:` : "Pick a region:",
              ...regionsResult.regions.map((r) => `  ${r.slug.padEnd(10)} ${r.name}`),
              "",
              "Re-run deploy_node with the region and I'll show server sizes with pricing.",
            ].join("\n"),
          },
        ],
      };
    }
    const region = args.region;

    const sizesResult = await apiRequest<{
      sizes: Array<{ slug: string; label: string; monthlyCostCents: number }>;
    }>(baseUrl, `/vps-credentials/${credId}/sizes?region=${region}`, { token: authToken });
    if (sizesResult.sizes.length === 0) {
      return errorText("No server sizes available in this region — try another region.");
    }

    const recommended = sizesResult.sizes[0];
    let size: string;
    if (!args.size) {
      return {
        content: [
          {
            type: "text",
            text: [
              `Server sizes in ${region} (a Lightning node runs fine on the smallest):`,
              ...sizesResult.sizes.map(
                (s) =>
                  `  ${s.slug.padEnd(14)} ${s.label} — $${(s.monthlyCostCents / 100).toFixed(2)}/mo${s.slug === recommended.slug ? "  ← recommended" : ""}`,
              ),
              "",
              `Re-run deploy_node with size (or size "recommended") to start the deploy.`,
            ].join("\n"),
          },
        ],
      };
    }
    if (args.size === "recommended") {
      size = recommended.slug;
    } else if (sizesResult.sizes.some((s) => s.slug === args.size)) {
      size = args.size;
    } else {
      return errorText(
        `Size "${args.size}" isn't available in ${region}. Options: ${sizesResult.sizes.map((s) => s.slug).join(", ")} (or "recommended").`,
      );
    }

    const deployResult = await apiRequest<{
      node: {
        id: string;
        status: string;
        vpsIp: string | null;
        monthlyCostCents: number | null;
      };
    }>(baseUrl, "/nodes/deploy", {
      method: "POST",
      body: {
        credentialId: credId,
        region,
        size,
        torEnabled: args.tor ?? false,
      },
      token: authToken,
    });

    const node = deployResult.node;
    const cost = node.monthlyCostCents
      ? `$${(node.monthlyCostCents / 100).toFixed(2)}/month`
      : "unknown";

    return {
      content: [
        {
          type: "text",
          text: [
            `${deprecationNote}Lightning node deployment started.`,
            ``,
            `Node ID: ${node.id}`,
            `Status: ${node.status}`,
            `Region: ${region}`,
            `Monthly cost: ${cost}`,
            ``,
            `The node will be ready in about 5 minutes.`,
            `Use the node_status tool with node_id "${node.id}" to check progress — or node_status with wait_for "wallet_pending" to block until the VPS is up and the wallet step is next.`,
            ``,
            `IMPORTANT: The user must complete wallet setup manually.`,
            `When the status reaches "wallet_pending", send them to`,
            `${SITE_URL}/nodes/${node.id} — it walks them through creating the`,
            `wallet in Lightning Terminal and writing down the 24-word seed`,
            `phrase, then they confirm "I've backed up my seed" there.`,
            ``,
            `The seed phrase is generated on the user's VPS and never touches bolthub.`,
            ``,
            `Once the node is ready, ask me to make it the payout wallet:`,
            `connect_wallet with node_id "${node.id}" binds it server-side, no secrets in chat.`,
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to deploy node: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

interface NodeStatusRow {
  id: string;
  status: string;
  vpsIp: string | null;
  lndRestHost: string | null;
  monthlyCostCents: number | null;
  lastError: string | null;
  torAddress: string | null;
  hasLndMacaroon: boolean;
  hasLncPairing: boolean;
  tenantId: string | null;
  /** Capacity sweep (every ~5 min); null = not measured yet. */
  activeChannelCount?: number | null;
  receivingCapacitySat?: number | null;
}

/**
 * Waitable milestones for `wait_for` (L5: agents driving deploy → wallet →
 * bind unattended). A node already PAST a milestone counts as met — the
 * point is "has it happened", not "is it there right now".
 */
const NODE_WAIT_TARGETS = {
  wallet_pending: "the VPS is up and LND is waiting for its wallet",
  ready: "the node is fully set up (wallet created, macaroon minted)",
  payable: "the node can RECEIVE payments (an active channel with inbound capacity)",
} as const;
type NodeWaitTarget = keyof typeof NODE_WAIT_TARGETS;

const NODE_STATUS_RANK: Record<string, number> = {
  provisioning: 0,
  installing: 1,
  wallet_pending: 2,
  syncing: 3,
  ready: 4,
};

const DEFAULT_WAIT_TIMEOUT_S = 120;
const MAX_WAIT_TIMEOUT_S = 600;
const WAIT_POLL_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function waitTargetMet(node: NodeStatusRow, target: NodeWaitTarget): boolean {
  if (target === "payable") {
    return (
      node.status === "ready" &&
      (node.activeChannelCount ?? 0) > 0 &&
      (node.receivingCapacitySat ?? 0) > 0
    );
  }
  return (NODE_STATUS_RANK[node.status] ?? -1) >= NODE_STATUS_RANK[target];
}

/** What to do when a wait timed out, per target — never "just keep polling". */
function waitTimeoutGuidance(target: NodeWaitTarget, node: NodeStatusRow): string {
  switch (target) {
    case "wallet_pending":
      return "Provisioning normally takes ~5 minutes. Re-run node_status with the same wait_for to keep waiting; if it sits in provisioning/installing well past 15 minutes, check the Error line above (or the dashboard) instead of waiting again.";
    case "ready":
      return node.status === "syncing"
        ? "The node is syncing; that finishes on its own. Re-run node_status with the same wait_for."
        : "Re-run node_status with the same wait_for, or check the Error line above.";
    case "payable":
      return "This is normal if a channel was just opened: channel opens need on-chain confirmations (typically 10-60 min) and the capacity sweep runs every ~5 minutes. Tell the user, do something else, and re-run node_status with wait_for \"payable\" later instead of polling in a tight loop.";
  }
}

async function fetchNodeStatus(
  baseUrl: string,
  nodeId: string,
  authToken?: string,
): Promise<NodeStatusRow> {
  const result = await apiRequest<{ node: NodeStatusRow }>(baseUrl, `/nodes/${nodeId}`, {
    token: authToken,
  });
  return result.node;
}

export async function handleNodeStatus(
  args: { node_id: string; wait_for?: string; timeout_s?: number },
  apiUrl?: string,
  authToken?: string,
  // Poll cadence is injectable for tests only; callers use the default.
  pollIntervalMs: number = WAIT_POLL_MS,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;

  try {
    if (args.wait_for !== undefined && !(args.wait_for in NODE_WAIT_TARGETS)) {
      return errorText(
        `wait_for must be one of: ${Object.keys(NODE_WAIT_TARGETS).join(", ")}. Omit it for a one-shot status check.`,
      );
    }
    const target = args.wait_for as NodeWaitTarget | undefined;

    let timeoutS = DEFAULT_WAIT_TIMEOUT_S;
    if (args.timeout_s !== undefined) {
      if (!target) {
        return errorText("timeout_s only makes sense together with wait_for.");
      }
      if (!Number.isFinite(args.timeout_s) || args.timeout_s < 5 || args.timeout_s > MAX_WAIT_TIMEOUT_S) {
        return errorText(`timeout_s must be between 5 and ${MAX_WAIT_TIMEOUT_S} seconds.`);
      }
      timeoutS = Math.floor(args.timeout_s);
    }

    const started = Date.now();
    const deadline = started + timeoutS * 1000;
    let polls = 0;
    let node = await fetchNodeStatus(baseUrl, args.node_id, authToken);
    polls++;

    if (target) {
      for (;;) {
        // Terminal states fail loudly and immediately — waiting can't fix them.
        if (node.status === "error" || node.status === "destroyed") {
          return {
            content: [
              {
                type: "text",
                text: `WAIT FAILED: node ${node.id} is in terminal state "${node.status}"${node.lastError ? ` (${node.lastError})` : ""}. Waiting cannot recover this; surface it to the user.`,
              },
            ],
            isError: true,
          };
        }
        if (waitTargetMet(node, target)) break;
        // wallet_pending only advances when the USER completes the seed
        // ceremony in the browser. Polling past it is a silent dead loop —
        // stop immediately and say what has to happen.
        if (node.status === "wallet_pending" && (target === "ready" || target === "payable")) {
          return {
            content: [
              {
                type: "text",
                text:
                  `WAIT STOPPED (not a timeout): node ${node.id} is in "wallet_pending", and only the user can advance it — they must create the node's wallet at ${SITE_URL}/nodes/${node.id} (24-word seed, generated on their VPS). ` +
                  `Waiting for "${target}" cannot progress until that's done. Ask the user to complete it, then re-run node_status with wait_for "${target}".`,
              },
            ],
            isError: true,
          };
        }
        if (Date.now() + pollIntervalMs > deadline) {
          return {
            content: [
              {
                type: "text",
                text:
                  `TIMED OUT after ${timeoutS}s (${polls} check(s)) waiting for "${target}" — ${NODE_WAIT_TARGETS[target]}.\n` +
                  `Current state: status ${node.status}, channels ${node.activeChannelCount ?? "unmeasured"}, inbound ${node.receivingCapacitySat ?? "unmeasured"} sats${node.lastError ? `, error: ${node.lastError}` : ""}.\n` +
                  waitTimeoutGuidance(target, node),
              },
            ],
            isError: true,
          };
        }
        await sleep(pollIntervalMs);
        node = await fetchNodeStatus(baseUrl, args.node_id, authToken);
        polls++;
      }
    }

    const lines = [
      `Node: ${node.id}`,
      `Status: ${node.status}`,
      `IP: ${node.vpsIp ?? "pending"}`,
    ];
    if (target) {
      lines.unshift(
        `Waited ${Math.round((Date.now() - started) / 1000)}s (${polls} check(s)) — "${target}" met: ${NODE_WAIT_TARGETS[target]}.`,
        "",
      );
    }

    if (node.lndRestHost) lines.push(`LND REST: ${node.lndRestHost}`);
    if (node.torAddress) lines.push(`Tor: ${node.torAddress}`);
    if (node.lastError) lines.push(`Error: ${node.lastError}`);
    if (node.tenantId) lines.push(`Connected to project: ${node.tenantId}`);

    if (node.status === "wallet_pending") {
      lines.push(
        "",
        "ACTION REQUIRED: the user must create the node's wallet.",
        `Send them to ${SITE_URL}/nodes/${node.id} — it opens the Lightning`,
        "Terminal UI and walks them through writing down the 24-word seed",
        "phrase (generated on their VPS; bolthub never sees it).",
        "",
        "If Lightning Terminal shows \"LND is not running\", the node is still",
        "booting — that error is expected for the first few minutes after the",
        "VM comes up. Nothing is broken; wait a couple of minutes and refresh.",
      );
    } else if (node.status === "ready") {
      // Reachable is NOT payable (H1): report capacity, never a blanket
      // "ready to receive payments" a channel-less node can't honor.
      const chans = node.activeChannelCount;
      const inbound = node.receivingCapacitySat;
      if (chans === 0 || inbound === 0) {
        lines.push(
          "",
          `Node is online and reachable, but CANNOT RECEIVE PAYMENTS: ${chans === 0 ? "it has no channels" : "its channels have no inbound capacity left"}.`,
          "Buyers paying a workspace backed by this node get a raw Lightning routing error.",
          "Get an inbound channel:",
          "  - Open a channel TO this node from another node you control, or",
          "  - Buy an inbound channel from an LSP via the node's Lightning Terminal (Loop/Pool).",
          "Channel opens need on-chain confirmations (typically 10-60 min); re-run node_status to re-check.",
        );
      } else if (chans == null) {
        lines.push(
          "",
          "Node is online and reachable. Channel capacity hasn't been measured yet (the sweep runs every ~5 minutes) — until it is, treat \"can receive payments\" as unknown.",
        );
      } else {
        lines.push(
          "",
          `Node is online with ${chans} active channel(s) and ~${inbound} sats of inbound capacity — ready to receive payments.`,
        );
      }
      if (!node.tenantId) {
        lines.push(
          `Not yet a payout wallet — run connect_wallet with node_id "${node.id}" to bind it to a workspace (server-side, no secrets in chat), or use the dashboard.`,
        );
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to get node status: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/** Owner-API request helper, shared with seller-tools.ts (same JWT auth). */
export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  // 30s abort (2026-07-15 smoke-test finding): without it, one stalled
  // connection hangs the tool call forever — and in a stdio connector that
  // wedges the whole session with no way for the agent to recover.
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `API returned ${res.status}`);
  }

  return res.json() as Promise<T>;
}

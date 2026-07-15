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
        return errorText(
          [
            "Several stored credentials — re-run with credential_id set to one of:",
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
            `Use the node_status tool with node_id "${node.id}" to check progress.`,
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

export async function handleNodeStatus(
  args: { node_id: string },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;

  try {
    const result = await apiRequest<{
      node: {
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
      };
    }>(baseUrl, `/nodes/${args.node_id}`, { token: authToken });

    const node = result.node;
    const lines = [
      `Node: ${node.id}`,
      `Status: ${node.status}`,
      `IP: ${node.vpsIp ?? "pending"}`,
    ];

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
      );
    } else if (node.status === "ready") {
      lines.push("", "Node is online and ready to receive payments.");
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

  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `API returned ${res.status}`);
  }

  return res.json() as Promise<T>;
}

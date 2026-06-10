type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_API_URL = "https://api.bolthub.ai";

export async function handleDeployNode(
  args: {
    provider: string;
    api_key: string;
    region?: string;
    tor?: boolean;
  },
  apiUrl?: string,
  authToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;

  try {
    const credResult = await apiRequest<{
      credential: { id: string; provider: string; label: string };
    }>(baseUrl, "/vps-credentials", {
      method: "POST",
      body: { provider: args.provider, apiKey: args.api_key, label: "MCP-created" },
      token: authToken,
    });

    const credId = credResult.credential.id;

    const regionsResult = await apiRequest<{
      regions: Array<{ slug: string; name: string }>;
    }>(baseUrl, `/vps-credentials/${credId}/regions`, { token: authToken });

    const region = args.region ?? regionsResult.regions[0]?.slug;
    if (!region) {
      return {
        content: [{ type: "text", text: "No regions available for this provider." }],
        isError: true,
      };
    }

    const sizesResult = await apiRequest<{
      sizes: Array<{ slug: string; label: string; monthlyCostCents: number }>;
    }>(baseUrl, `/vps-credentials/${credId}/sizes?region=${region}`, { token: authToken });

    const size = sizesResult.sizes[0]?.slug;
    if (!size) {
      return {
        content: [{ type: "text", text: "No server sizes available in this region." }],
        isError: true,
      };
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
            `Lightning node deployment started.`,
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
            `When the status is "wallet_pending", the user needs to:`,
            `1. Open the Lightning Terminal UI at the node's URL`,
            `2. Create their wallet and write down the 24-word seed phrase`,
            `3. Click "I've backed up my seed" in the bolthub dashboard`,
            ``,
            `The seed phrase is generated on the user's VPS and never touches bolthub.`,
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
        "ACTION REQUIRED: The user must open the Lightning Terminal UI",
        `at ${node.lndRestHost} and create their wallet.`,
        "They will see a 24-word seed phrase that they must write down.",
      );
    } else if (node.status === "ready") {
      lines.push("", "Node is online and ready to receive payments.");
      if (!node.tenantId) {
        lines.push("Use the bolthub dashboard to connect this node as a receiving wallet.");
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

async function apiRequest<T>(
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

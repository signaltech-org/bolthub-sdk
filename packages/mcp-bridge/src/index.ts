#!/usr/bin/env node

import { fetchOpenApiSpec, convertOpenApiToTools } from "./openapi-to-tools.js";
import { startMcpServer } from "./server.js";
import {
  L402Client,
  LndWallet,
  LnbitsWallet,
  PhoenixdWallet,
  NwcWallet,
  FileSessionStore,
} from "@bolthub/agent";
import type { WalletAdapter } from "@bolthub/agent";

function parseArgs(argv: string[]): { gateway: string; budgetSats?: number } {
  const args = argv.slice(2);
  let gateway: string | undefined;
  let budgetSats: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--gateway" && args[i + 1]) {
      gateway = args[i + 1];
      i++;
    } else if (args[i] === "--budget" && args[i + 1]) {
      budgetSats = parseInt(args[i + 1], 10);
      i++;
    }
  }

  if (!gateway) {
    console.error("Usage: mcp-bridge --gateway <gateway-url> [--budget <sats>]");
    console.error("Example: mcp-bridge --gateway https://pokemon.gw.bolthub.ai --budget 1000");
    process.exit(1);
  }

  return { gateway, budgetSats };
}

function resolveBudget(cliBudget?: number): number | undefined {
  if (cliBudget && cliBudget > 0) return cliBudget;
  const envBudget = process.env.BUDGET_SATS;
  if (envBudget) {
    const parsed = parseInt(envBudget, 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

async function createWallet(): Promise<WalletAdapter> {
  if (process.env.LND_REST_HOST && process.env.LND_MACAROON) {
    console.error("[mcp-bridge] Using LND wallet (fastest, <200ms payments)");
    return new LndWallet({
      host: process.env.LND_REST_HOST,
      macaroon: process.env.LND_MACAROON,
    });
  }

  if (process.env.LNBITS_URL && process.env.LNBITS_ADMIN_KEY) {
    console.error("[mcp-bridge] Using LNbits wallet (fast, <300ms payments)");
    return new LnbitsWallet({
      url: process.env.LNBITS_URL,
      adminKey: process.env.LNBITS_ADMIN_KEY,
    });
  }

  if (process.env.PHOENIXD_URL && process.env.PHOENIXD_PASSWORD) {
    console.error("[mcp-bridge] Using Phoenixd wallet (fast, <200ms payments)");
    return new PhoenixdWallet({
      baseUrl: process.env.PHOENIXD_URL,
      password: process.env.PHOENIXD_PASSWORD,
    });
  }

  const nwcUri = process.env.NWC_URI;
  if (nwcUri) {
    console.error("[mcp-bridge] Using NWC wallet (slower, 1-3s payments via relay)");
    try {
      const { nwc } = await import("@getalby/sdk");
      const client = new nwc.NWCClient({ nostrWalletConnectUrl: nwcUri });
      return new NwcWallet({
        payInvoice: async (invoice: string) => {
          const result = await client.payInvoice({ invoice });
          return { preimage: result.preimage };
        },
      });
    } catch {
      console.error(
        "[mcp-bridge] @getalby/sdk not available. Install it for NWC support: npm install @getalby/sdk",
      );
      process.exit(1);
    }
  }

  console.error("Error: No wallet configured. Set one of the following:");
  console.error("  PHOENIXD_URL + PHOENIXD_PASSWORD     (recommended, fast <200ms)");
  console.error("  LND_REST_HOST + LND_MACAROON         (fastest, <200ms)");
  console.error("  LNBITS_URL + LNBITS_ADMIN_KEY        (fast, <300ms)");
  console.error("  NWC_URI                              (easiest, but slower 1-3s)");
  process.exit(1);
}

async function main() {
  const { gateway, budgetSats: cliBudget } = parseArgs(process.argv);

  console.error(`[mcp-bridge] Fetching OpenAPI spec from ${gateway}...`);
  const spec = await fetchOpenApiSpec(gateway);
  const tools = convertOpenApiToTools(spec, gateway);

  if (tools.length === 0) {
    console.error("[mcp-bridge] No tools found in OpenAPI spec. Check your gateway URL.");
    process.exit(1);
  }

  console.error(`[mcp-bridge] Discovered ${tools.length} tool(s):`);
  for (const t of tools) {
    console.error(`  - ${t.name}: ${t.description}`);
  }

  const wallet = await createWallet();
  const budgetSats = resolveBudget(cliBudget);
  const sessionStore = new FileSessionStore();
  const l402Client = new L402Client({ wallet, timeoutMs: 45_000, budgetSats, sessionStore });

  if (budgetSats) {
    console.error(`[mcp-bridge] Spending budget: ${budgetSats} sats per session`);
  } else {
    console.error("[mcp-bridge] No spending budget set (unlimited)");
  }

  const slug = gateway.match(/\/\/([^.]+)\./)?.[1] ?? "bolthub";
  await startMcpServer(tools, l402Client, `${slug}-mcp-bridge`);
  console.error("[mcp-bridge] MCP server started on stdio");
}

main().catch((err) => {
  console.error("[mcp-bridge] Fatal error:", err.message ?? err);
  process.exit(1);
});

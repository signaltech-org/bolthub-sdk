#!/usr/bin/env node

import {
  L402Client,
  LndWallet,
  LnbitsWallet,
  PhoenixdWallet,
  NwcWallet,
  FileSessionStore,
} from "@bolthub/agent";
import type { WalletAdapter } from "@bolthub/agent";
import { ApiClient } from "./api-client.js";
import { startRegistryServer } from "./server.js";

function parseArgs(argv: string[]): { apiUrl?: string; budgetSats?: number } {
  const args = argv.slice(2);
  let apiUrl: string | undefined;
  let budgetSats: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-url" && args[i + 1]) {
      apiUrl = args[i + 1];
      i++;
    } else if (args[i] === "--budget" && args[i + 1]) {
      budgetSats = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { apiUrl, budgetSats };
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
    console.error("[mcp-registry] Using LND wallet");
    return new LndWallet({
      host: process.env.LND_REST_HOST,
      macaroon: process.env.LND_MACAROON,
    });
  }

  if (process.env.LNBITS_URL && process.env.LNBITS_ADMIN_KEY) {
    console.error("[mcp-registry] Using LNbits wallet");
    return new LnbitsWallet({
      url: process.env.LNBITS_URL,
      adminKey: process.env.LNBITS_ADMIN_KEY,
    });
  }

  if (process.env.PHOENIXD_URL && process.env.PHOENIXD_PASSWORD) {
    console.error("[mcp-registry] Using Phoenixd wallet");
    return new PhoenixdWallet({
      baseUrl: process.env.PHOENIXD_URL,
      password: process.env.PHOENIXD_PASSWORD,
    });
  }

  const nwcUri = process.env.NWC_URI;
  if (nwcUri) {
    console.error("[mcp-registry] Using NWC wallet");
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
        "[mcp-registry] @getalby/sdk not available. Install it for NWC support: npm install @getalby/sdk",
      );
      process.exit(1);
    }
  }

  console.error("Error: No wallet configured. Set one of the following:");
  console.error("  LND_REST_HOST + LND_MACAROON         (recommended, fastest <200ms)");
  console.error("  PHOENIXD_URL + PHOENIXD_PASSWORD     (fast <200ms, auto liquidity)");
  console.error("  LNBITS_URL + LNBITS_ADMIN_KEY        (fast <300ms)");
  console.error("  NWC_URI                              (easiest, but slower 1-3s)");
  process.exit(1);
}

async function main() {
  const { apiUrl, budgetSats: cliBudget } = parseArgs(process.argv);

  console.error("[mcp-registry] bolthub API Registry MCP");
  console.error("[mcp-registry] One config → every API on the marketplace");

  const apiClient = new ApiClient(apiUrl);
  const wallet = await createWallet();
  const budgetSats = resolveBudget(cliBudget);
  const sessionStore = new FileSessionStore();
  const l402Client = new L402Client({ wallet, timeoutMs: 45_000, budgetSats, sessionStore });

  console.error("[mcp-registry] Session tokens persisted to ~/.bolthub/sessions.json");

  if (budgetSats) {
    console.error(`[mcp-registry] Spending budget: ${budgetSats} sats per session`);
  } else {
    console.error("[mcp-registry] No spending budget set (unlimited)");
  }

  await startRegistryServer(apiClient, l402Client);
  console.error("[mcp-registry] MCP server started on stdio");
}

main().catch((err) => {
  console.error("[mcp-registry] Fatal error:", err.message ?? err);
  process.exit(1);
});

#!/usr/bin/env node

import {
  L402Client,
  FileSessionStore,
  FileReceiptStore,
  exportReceipts,
  verifyReceipt,
  walletFromEnv,
  WALLET_ENV_HINT,
} from "@bolthub/pay";
import type { WalletAdapter, NwcConnection } from "@bolthub/pay";

const API_URL = process.env.BOLTHUB_API_URL || "https://api.bolthub.ai";
const GATEWAY_DOMAIN = "gw.bolthub.ai";

interface DirectoryEndpoint {
  path: string;
  method: string;
  title: string | null;
  description: string | null;
  pricingModel: string | null;
  priceSats: number | null;
  tokenBudget: number | null;
  durationMinutes: number | null;
  unitCostSats: number | null;
  freeTryEnabled: boolean;
}

interface DirectoryEntry {
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  gatewayDomain: string;
  endpointCount: number;
  endpoints: DirectoryEndpoint[];
  quality?: {
    isHealthy: boolean;
    uptimePercentage: number | null;
    avgResponseTimeMs: number | null;
  };
}

/** Format an endpoint's pricing model into a human-readable string. */
export function formatPricing(ep: DirectoryEndpoint): string {
  if (!ep.priceSats) return "free";
  switch (ep.pricingModel) {
    case "per_kb":
      return `${ep.unitCostSats ?? ep.priceSats} sats/KB (${ep.priceSats} deposit)`;
    case "token_bucket":
      return `${ep.priceSats} sats for ${ep.tokenBudget ?? "N"} requests`;
    case "time_pass":
      return `${ep.priceSats} sats for ${ep.durationMinutes ?? "N"} min`;
    case "metered":
      return `${ep.priceSats} deposit, ${ep.unitCostSats ?? "N"} sats/req`;
    default:
      return `${ep.priceSats} sats/request`;
  }
}

/** Search the BoltHub directory and print results to stdout. */
export async function search(query?: string, tag?: string): Promise<void> {
  const params = new URLSearchParams();
  if (query) params.set("search", query);
  if (tag) params.set("tag", tag);
  params.set("limit", "20");

  const resp = await fetch(`${API_URL}/directory?${params}`);
  if (!resp.ok) {
    console.error(`Error: API returned ${resp.status}`);
    process.exit(1);
  }

  const data = await resp.json();
  const entries: DirectoryEntry[] = data.entries ?? [];

  if (entries.length === 0) {
    console.log(query || tag ? `No APIs found matching "${query ?? tag}".` : "No APIs listed yet.");
    return;
  }

  console.log(`Found ${entries.length} API${entries.length === 1 ? "" : "s"}:\n`);

  for (const entry of entries) {
    const health = entry.quality?.uptimePercentage != null
      ? ` [${entry.quality.uptimePercentage}% uptime]`
      : "";
    console.log(`  ${entry.name} (${entry.slug})${health}`);
    if (entry.description) console.log(`    ${entry.description}`);
    if (entry.tags.length > 0) console.log(`    Tags: ${entry.tags.join(", ")}`);
    console.log(`    ${entry.endpointCount} endpoint${entry.endpointCount !== 1 ? "s" : ""}`);

    const prices = entry.endpoints
      .map((ep) => ep.priceSats)
      .filter((p): p is number => p != null && p > 0);
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      console.log(`    Price: ${min === max ? `${min} sats` : `${min}–${max} sats`}`);
    }
    console.log();
  }

  console.log(`Use: bolthub info <slug>    — full details`);
  console.log(`Use: bolthub call <slug> <path>  — call an endpoint`);
}

/** Fetch and display full details for a single API. */
export async function info(slug: string): Promise<void> {
  const resp = await fetch(`${API_URL}/directory/${encodeURIComponent(slug)}`);
  if (!resp.ok) {
    if (resp.status === 404) {
      console.error(`API "${slug}" not found in the bolthub directory.`);
    } else {
      console.error(`Error: API returned ${resp.status}`);
    }
    process.exit(1);
  }

  const entry: DirectoryEntry = await resp.json();

  console.log(`${entry.name}\n`);
  if (entry.description) console.log(`${entry.description}\n`);
  console.log(`Slug:    ${entry.slug}`);
  console.log(`Gateway: ${entry.gatewayDomain}`);
  if (entry.tags.length > 0) console.log(`Tags:    ${entry.tags.join(", ")}`);

  if (entry.quality) {
    const parts: string[] = [];
    if (entry.quality.uptimePercentage != null) parts.push(`${entry.quality.uptimePercentage}% uptime`);
    if (entry.quality.avgResponseTimeMs != null) parts.push(`${entry.quality.avgResponseTimeMs}ms avg`);
    if (parts.length > 0) console.log(`Quality: ${parts.join(", ")}`);
  }

  console.log(`\nEndpoints:\n`);

  for (const ep of entry.endpoints) {
    console.log(`  ${ep.method} ${ep.path}`);
    if (ep.title) console.log(`    ${ep.title}`);
    if (ep.description) console.log(`    ${ep.description}`);
    console.log(`    Pricing: ${formatPricing(ep)}`);
    if (ep.freeTryEnabled) console.log(`    Free try: available`);
    console.log();
  }

  console.log(`Use: bolthub call ${slug} <path> [--max-cost <sats>]`);
  console.log(`Use: lnget --max-cost 100 ${entry.gatewayDomain}/<path>`);
}

/**
 * Wallet adapter with an optional teardown. NWC holds a relay websocket
 * open; a one-shot CLI must close it or the process never exits (and
 * piped stdout never flushes — the response prints, but nobody sees it).
 */
export type CliWallet = WalletAdapter & { close?: () => void };

/**
 * NWC connector backed by `@getalby/sdk` (a real dependency of the CLI;
 * loaded lazily so the common wallets don't pay its import cost).
 */
async function nwcConnect(uri: string): Promise<NwcConnection & { close?: () => void }> {
  const { NWCClient } = await import("@getalby/sdk");
  const client = new NWCClient({ nostrWalletConnectUrl: uri });
  return {
    payInvoice: async (invoice: string) => {
      const result = await client.payInvoice({ invoice });
      return { preimage: result.preimage };
    },
    close: () => client.close(),
  };
}

/** Select a wallet adapter based on environment variables. */
export async function createWallet(): Promise<CliWallet> {
  let wallet: CliWallet | undefined;
  try {
    wallet = await walletFromEnv({ nwcConnect });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  if (!wallet) {
    console.error("No wallet configured.");
    console.error(WALLET_ENV_HINT);
    process.exit(1);
  }
  return wallet;
}

/** Call a gateway endpoint via the L402 client and print the response. */
async function call(
  slug: string,
  path: string,
  options: {
    method?: string;
    maxCost?: number;
    body?: string;
    budget?: number;
  },
): Promise<void> {
  const wallet = await createWallet();
  const sessionStore = new FileSessionStore();
  const l402Client = new L402Client({
    wallet,
    timeoutMs: 45_000,
    budgetSats: options.budget,
    maxPerRequestSats: options.maxCost,
    sessionStore,
  });

  const method = (options.method ?? "GET").toUpperCase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `https://${slug}.${GATEWAY_DOMAIN}${normalizedPath}`;

  const fetchOptions: RequestInit = { method };
  if (options.body && method !== "GET" && method !== "HEAD") {
    fetchOptions.headers = { "Content-Type": "application/json" };
    fetchOptions.body = options.body;
  }

  try {
    const resp = await l402Client.request(url, fetchOptions);
    const text = await resp.text();

    if (!resp.ok) {
      console.error(`HTTP ${resp.status}`);
      console.log(text);
      process.exit(1);
    }

    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }

    if (l402Client.totalSpent > 0) {
      console.error(`\nCost: ${l402Client.totalSpent} sats`);
      if (l402Client.remainingBudget !== Infinity) {
        console.error(`Remaining budget: ${l402Client.remainingBudget} sats`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    wallet.close?.();
  }
}

/**
 * `bolthub receipts export`: serialize the local receipt ledger
 * (`~/.bolthub/receipts.jsonl` unless --file) to stdout as JSON or CSV.
 */
export function receiptsExport(options: {
  file?: string;
  format?: "json" | "csv";
  redact?: boolean;
  from?: string;
  to?: string;
}): string {
  const store = new FileReceiptStore(options.file);
  const receipts = store.list({
    from: options.from ? new Date(options.from) : undefined,
    to: options.to ? new Date(options.to) : undefined,
  });
  return exportReceipts(receipts, { format: options.format, redact: options.redact });
}

/**
 * `bolthub receipts verify`: run the offline checks (sha256(preimage) ==
 * payment_hash == the hash the BOLT11 commits to; amount consistency) on
 * every receipt in the ledger. Returns the summary text and whether every
 * receipt held up (redacted receipts don't fail the run; they're expense
 * records by design).
 */
export function receiptsVerify(options: { file?: string }): { text: string; ok: boolean } {
  const store = new FileReceiptStore(options.file);
  const receipts = store.list();
  if (receipts.length === 0) {
    return { text: "No receipts to verify.", ok: true };
  }
  const counts = { valid: 0, redacted: 0, invalid: 0, unverifiable: 0 };
  const failures: string[] = [];
  receipts.forEach((r, idx) => {
    const result = verifyReceipt(r);
    counts[result.status]++;
    if (result.status === "invalid" || result.status === "unverifiable") {
      failures.push(
        `#${idx + 1} ${r.ts} ${r.method} ${r.resource} (${r.amount_sats} sats): ${result.reasons.join("; ")}`,
      );
    }
  });
  const lines = [
    `${receipts.length} receipt(s): ${counts.valid} valid, ${counts.redacted} redacted, ${counts.invalid} invalid, ${counts.unverifiable} unverifiable`,
  ];
  if (failures.length > 0) lines.push("", ...failures);
  return { text: lines.join("\n"), ok: counts.invalid === 0 && counts.unverifiable === 0 };
}

function printUsage(): void {
  console.log(`bolthub — CLI for the bolthub L402 API marketplace

Usage:
  bolthub search [query]              Search APIs by keyword
  bolthub search --tag <tag>          Search APIs by tag
  bolthub info <slug>                 Get full details for an API
  bolthub call <slug> <path>          Call an API endpoint
  bolthub receipts export             Export the payment receipt ledger
  bolthub receipts verify             Verify every receipt offline (proof-of-payment)

Options for call:
  --method <METHOD>       HTTP method (default: GET)
  --max-cost <sats>       Refuse invoices above this amount
  --budget <sats>         Total session spending limit
  --body <json>           JSON request body (for POST/PUT/PATCH)

Options for receipts export:
  --format <json|csv>     Output format (default: json)
  --redact                Strip preimages (shareable expense report)
  --from <ISO date>       Only receipts at or after this time
  --to <ISO date>         Only receipts at or before this time
  --file <path>           Ledger path (default: ~/.bolthub/receipts.jsonl)

Environment:
  PHOENIXD_URL + PHOENIXD_PASSWORD     Recommended wallet
  LND_REST_HOST + LND_MACAROON        Fastest wallet
  LNBITS_URL + LNBITS_ADMIN_KEY       LNbits wallet
  NWC_URI                              Easiest wallet (slower)

Examples:
  bolthub search bitcoin
  bolthub info btc-intel
  bolthub call btc-intel /v1/market/snapshot --max-cost 10
  bolthub call btc-intel "/v1/history/candles?timeframe=1h&limit=2" --max-cost 2
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "search") {
    let query: string | undefined;
    let tag: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--tag" && args[i + 1]) {
        tag = args[++i];
      } else if (!query) {
        query = args[i];
      }
    }
    return search(query, tag);
  }

  if (command === "info") {
    const slug = args[1];
    if (!slug) {
      console.error("Usage: bolthub info <slug>");
      process.exit(1);
    }
    return info(slug);
  }

  if (command === "call") {
    const slug = args[1];
    const path = args[2];
    if (!slug || !path) {
      console.error("Usage: bolthub call <slug> <path> [options]");
      process.exit(1);
    }

    const options: { method?: string; maxCost?: number; body?: string; budget?: number } = {};
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--method" && args[i + 1]) options.method = args[++i];
      else if (args[i] === "--max-cost" && args[i + 1]) options.maxCost = parseInt(args[++i], 10);
      else if (args[i] === "--budget" && args[i + 1]) options.budget = parseInt(args[++i], 10);
      else if (args[i] === "--body" && args[i + 1]) options.body = args[++i];
    }

    return call(slug, path, options);
  }

  if (command === "receipts") {
    const sub = args[1];
    if (sub === "verify") {
      let file: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--file" && args[i + 1]) file = args[++i];
      }
      const { text, ok } = receiptsVerify({ file });
      console.log(text);
      if (!ok) process.exit(1);
      return;
    }
    if (sub !== "export") {
      console.error("Usage: bolthub receipts <export|verify> [options]");
      process.exit(1);
    }
    const options: { file?: string; format?: "json" | "csv"; redact?: boolean; from?: string; to?: string } = {};
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--format" && args[i + 1]) {
        const fmt = args[++i];
        if (fmt !== "json" && fmt !== "csv") {
          console.error(`Unknown format: ${fmt} (json|csv)`);
          process.exit(1);
        }
        options.format = fmt;
      } else if (args[i] === "--redact") options.redact = true;
      else if (args[i] === "--from" && args[i + 1]) options.from = args[++i];
      else if (args[i] === "--to" && args[i + 1]) options.to = args[++i];
      else if (args[i] === "--file" && args[i + 1]) options.file = args[++i];
    }
    console.log(receiptsExport(options));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

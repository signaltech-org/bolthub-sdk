#!/usr/bin/env node

/**
 * `@bolthub/mcp` — the bolthub MCP server. One config entry in your MCP
 * client; behind it: the bolthub marketplace, specific L402 gateways, and
 * your other MCP servers, all sharing one wallet and one budget.
 *
 * Replaces `@bolthub/mcp-registry` (the `marketplace` source),
 * `@bolthub/mcp-bridge` (the `gateways` source), and ships the
 * `mcpServers` paying proxy designed in docs/design/mcp-proxy/DESIGN.md.
 */

import pkg from "../package.json" with { type: "json" };
import { parseArgs, resolveConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { createWallet } from "./wallet.js";
import { createPaymentServices } from "./payment.js";
import { GatewaySource } from "./sources/gateway.js";
import { MarketplaceSource } from "./sources/marketplace.js";
import { McpServerSource } from "./sources/mcp.js";
import { ReceiptsSource } from "./sources/receipts.js";
import type { ToolSource } from "./sources/source.js";
import { buildAggregate } from "./aggregate.js";
import { createUnifiedServer, serveStdio } from "./server.js";
import { log } from "./log.js";
import { WALLET_ENV_HINT } from "@bolthub/pay";

const HELP = `bolthub-mcp ${pkg.version} — the bolthub MCP server

One config entry, three kinds of tool source, one shared Lightning budget.

Usage:
  bolthub-mcp [flags]                      zero config = marketplace mode
  bolthub-mcp --gateway <url>              a specific gateway's endpoints as tools
  bolthub-mcp --config ~/.bolthub/mcp.json full config (marketplace + gateways + mcpServers)

Flags:
  --config <path>        config file (default: ${DEFAULT_CONFIG_PATH} when present)
  --gateway <url>        add a gateway source (repeatable)
  --marketplace          force the marketplace source on
  --no-marketplace       force it off
  --budget <sats>        lifetime budget for this run (budget.sat)
  --max-per-call <sats>  per-call ceiling (maxPerCall.sat)
  --api-url <url>        override the directory API base URL
  --receipts <path>      record proof-of-payment receipts to this JSONL file
                         ("default" = ~/.bolthub/receipts.jsonl) and enable
                         the export_receipts tool
  --help                 this text

Config file (~/.bolthub/mcp.json) — the "mcpServers" block is the exact shape
your MCP client already uses, so paste it in wholesale:
  {
    "marketplace": true,
    "gateways": ["https://btc-intel.gw.bolthub.ai"],
    "mcpServers": {
      "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] },
      "remote":     { "url": "https://tools.example.com/mcp", "headers": { "Authorization": "Bearer …" } }
    },
    "budget":     { "sat": 10000 },
    "maxPerCall": { "sat": 500 },
    "namespace":  "prefix",
    "telemetry":  false
  }

Env:
  BUDGET_SATS            fallback for budget.sat when neither --budget nor the
                         config file sets one (precedence: flag > file > env).
                         A malformed value aborts startup — it never silently
                         falls back to unlimited.
  RECEIPTS_PATH          fallback for the receipt ledger when neither
                         --receipts <path|default> nor "receipts" in the
                         config sets one. Records one proof-of-payment
                         receipt per paid call and enables the
                         export_receipts tool. Off unless configured.

Wallet (optional — free tools and marketplace search work without one):
${WALLET_ENV_HINT.split("\n").slice(1).join("\n")}

Notes:
  - Proxies MCP *tools* only (no resources/prompts in v1).
  - budget.sat: 0 is valid and means "free tools only".
  - Every log line goes to stderr; spend lines are your local audit trail.
`;

const INIT_TIMEOUT_MS = 15_000;

function warnOnNestedBolthubBins(config: ResolvedConfig): void {
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    const haystack =
      "command" in entry ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.url;
    if (/@bolthub\/(mcp-bridge|mcp-registry|mcp)\b/.test(haystack)) {
      log(
        `warning: mcpServers.${key} wraps a bolthub bin. It would pay from its OWN wallet env, ` +
          `invisible to this server's shared budget. Move it to "gateways" (for a gateway) or ` +
          `"marketplace": true instead.`,
      );
    }
  }
}

async function main() {
  const cli = parseArgs(process.argv);
  if (cli.help) {
    console.log(HELP);
    return;
  }

  const config = resolveConfig(cli);
  warnOnNestedBolthubBins(config);

  const nonSatBudgetKeys = Object.keys(config.budget).filter((a) => a !== "sat");
  if (nonSatBudgetKeys.length > 0 && Object.keys(config.mcpServers).length === 0) {
    log(
      `warning: budget for [${nonSatBudgetKeys.join(", ")}] only applies to downstream MCP offers, ` +
        `and no "mcpServers" are configured — gateway/marketplace payments are sat-only.`,
    );
  }

  const wallet = await createWallet();
  if (!wallet) {
    log("no wallet configured — free tools only; paid calls will return their challenge");
    log(WALLET_ENV_HINT);
  }
  const services = createPaymentServices(config, wallet);
  if (config.budget.sat !== undefined) {
    // Always name the source: when a run spends more than expected, the
    // first question is "which of flag/file/env actually won?".
    const source =
      config.budgetSatSource === "flag"
        ? "--budget"
        : config.budgetSatSource === "env"
          ? "BUDGET_SATS env"
          : `budget.sat in ${config.configPath ?? "config file"}`;
    log(`budget: ${config.budget.sat} sats for this run (from ${source})${config.maxPerCall.sat !== undefined ? `, max ${config.maxPerCall.sat} sats/call` : ""}`);
  } else {
    log("no budget set (unlimited) — consider --budget or budget.sat in the config");
  }

  if (services.receiptStore) {
    log(`receipts: recording to ${config.receipts?.path ?? "~/.bolthub/receipts.jsonl"} (export_receipts tool enabled)`);
  }

  // Build every configured source…
  const sources: ToolSource[] = [];
  if (config.marketplace) sources.push(new MarketplaceSource(config.marketplace, services));
  for (const gw of config.gateways) sources.push(new GatewaySource(gw, services));
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    sources.push(new McpServerSource(key, entry, services));
  }
  if (services.receiptStore) sources.push(new ReceiptsSource(services.receiptStore));
  if (sources.length === 0) {
    console.error("No tool sources configured. Run with --help for the config format.");
    process.exit(1);
  }

  // …init them in parallel, each under a timeout. A failing source is
  // skipped with a warning — one bad server must not down the rest. All
  // downstreams connect BEFORE the upstream (capabilities lock at connect).
  const ready: ToolSource[] = [];
  const results = await Promise.allSettled(
    sources.map(async (s) => {
      await withTimeout(s.init(), INIT_TIMEOUT_MS, `${s.kind} source "${s.key}"`);
      return s;
    }),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      ready.push(r.value);
      log(`${sources[i].kind} "${sources[i].key}": ${sources[i].listTools().length} tool(s)`);
    } else {
      log(`skipping ${sources[i].kind} "${sources[i].key}": ${r.reason instanceof Error ? r.reason.message : r.reason}`);
      void sources[i].close().catch(() => {});
    }
  }
  if (ready.length === 0) {
    console.error("Every configured source failed to start; exiting.");
    process.exit(1);
  }

  const aggregate = buildAggregate(ready, config.namespace);
  log(`serving ${aggregate.tools.length} tool(s) from ${ready.length} source(s) on stdio`);

  const server = createUnifiedServer(aggregate, { version: pkg.version });
  await serveStdio(server);

  // Teardown: close downstream children and the wallet's relay socket, or
  // the process outlives the MCP session (NWC keeps the event loop alive).
  let closing = false;
  const teardown = async (code: number) => {
    if (closing) return;
    closing = true;
    await Promise.allSettled(ready.map((s) => s.close()));
    wallet?.close?.();
    process.exit(code);
  };
  process.stdin.on("end", () => void teardown(0));
  process.on("SIGINT", () => void teardown(0));
  process.on("SIGTERM", () => void teardown(0));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

main().catch((err) => {
  console.error("[bolthub-mcp] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});

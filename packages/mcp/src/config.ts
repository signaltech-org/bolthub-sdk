/**
 * Config for the unified server: `~/.bolthub/mcp.json` + CLI flags + env.
 * Precedence: CLI flags > config file > env > built-in default.
 *
 * Zero config (`npx -y @bolthub/mcp` with no file and no source flags) means
 * marketplace-only mode — the old `@bolthub/mcp-registry` one-liner.
 * `--gateway <url>` with no config file means gateway-only mode — the old
 * `@bolthub/mcp-bridge` invocation.
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".bolthub", "mcp.json");

/**
 * Keys namespace tools as `key__toolName`, so a key may not itself contain
 * `__` (and must be non-empty `[a-zA-Z0-9_-]`).
 */
const keySchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/, "keys may only contain [a-zA-Z0-9_-]")
  .refine((k) => !k.includes("__"), "keys may not contain '__' (reserved as the namespace separator)");

const stdioServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict();

const httpServerSchema = z
  .object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

export const mcpServerEntrySchema = z.union([stdioServerSchema, httpServerSchema]);
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

const gatewayEntrySchema = z.union([
  z.string().url(),
  z.object({ url: z.string().url(), key: keySchema.optional() }).strict(),
]);

const amountsSchema = z.record(z.number().nonnegative());

const configFileSchema = z
  .object({
    marketplace: z
      .union([z.boolean(), z.object({ apiUrl: z.string().url().optional() }).strict()])
      .optional(),
    gateways: z.array(gatewayEntrySchema).optional(),
    mcpServers: z.record(keySchema, mcpServerEntrySchema).optional(),
    budget: amountsSchema.optional(),
    maxPerCall: amountsSchema.optional(),
    namespace: z.enum(["prefix", "flat"]).optional(),
    telemetry: z.boolean().optional(),
    /**
     * Preimage receipt ledger: `true` = record to the default path
     * (`~/.bolthub/receipts.jsonl`), a string = record to that path,
     * absent/false = off (nothing is ever written).
     */
    receipts: z.union([z.boolean(), z.string().min(1)]).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

export interface ResolvedConfig {
  /** `undefined` = marketplace source off. */
  marketplace?: { apiUrl?: string };
  gateways: { url: string; key?: string }[];
  mcpServers: Record<string, McpServerEntry>;
  /** Per-asset lifetime ceiling (`maxTotal`). */
  budget: Partial<Record<string, number>>;
  /** Per-asset per-call ceiling. */
  maxPerCall: Partial<Record<string, number>>;
  /** Where `budget.sat` came from, for the startup audit line. Unset = no sat budget. */
  budgetSatSource?: "flag" | "file" | "env";
  /** The config file that was actually loaded, when any. */
  configPath?: string;
  namespace: "prefix" | "flat";
  /** Reserved: validated and documented, but v1 sends nothing anywhere. */
  telemetry: boolean;
  /**
   * Present = record payment receipts. `path` unset = the store's default
   * (`~/.bolthub/receipts.jsonl`). Absent = off; nothing is ever written.
   */
  receipts?: { path?: string };
}

export interface CliArgs {
  configPath?: string;
  gateways: string[];
  marketplace?: boolean;
  budgetSats?: number;
  maxPerCallSats?: number;
  apiUrl?: string;
  /** `"default"` = the store's default path. */
  receiptsPath?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const out: CliArgs = { gateways: [], help: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      i++;
      return v;
    };
    if (a === "--config") out.configPath = next();
    else if (a === "--gateway") out.gateways.push(next());
    else if (a === "--marketplace") out.marketplace = true;
    else if (a === "--no-marketplace") out.marketplace = false;
    else if (a === "--budget") out.budgetSats = parsePositiveInt(next(), a);
    else if (a === "--max-per-call") out.maxPerCallSats = parsePositiveInt(next(), a);
    else if (a === "--api-url") out.apiUrl = next();
    else if (a === "--receipts") out.receiptsPath = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${a} (see --help)`);
  }
  return out;
}

/**
 * Strict: digits only. `parseInt` would quietly turn "500k" into 500 or
 * "5.5" into 5 — a spending limit must never be a truncation of what the
 * user typed.
 */
function parsePositiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${flag} expects a non-negative integer, got "${value}"`);
  }
  return parseInt(value.trim(), 10);
}

/**
 * `BUDGET_SATS` set to something unparseable must ABORT, not fall through to
 * unlimited — a malformed guardrail silently widening to "no limit" is the
 * one failure mode a budget may not have. Empty/whitespace counts as unset.
 */
function parseEnvBudget(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return parsePositiveInt(raw, "BUDGET_SATS");
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Load and validate a config file. Throws with a pointed message on bad JSON/schema. */
export function loadConfigFile(path: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read config file ${path}: ${err instanceof Error ? err.message : err}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Config file ${path} is invalid:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Merge CLI > file > env > defaults into the resolved config.
 * `env.BUDGET_SATS` seeds `budget.sat` (parity with the old bins).
 */
export function resolveConfig(
  cli: CliArgs,
  env: Record<string, string | undefined> = process.env,
): ResolvedConfig {
  const explicitPath = cli.configPath ? expandTilde(cli.configPath) : undefined;
  if (explicitPath && !existsSync(explicitPath)) {
    throw new Error(`Config file not found: ${explicitPath}`);
  }
  const defaultExists = existsSync(DEFAULT_CONFIG_PATH);
  const path = explicitPath ?? (defaultExists ? DEFAULT_CONFIG_PATH : undefined);
  const file: ConfigFile = path ? loadConfigFile(path) : {};

  const gateways: { url: string; key?: string }[] = (file.gateways ?? []).map((g) =>
    typeof g === "string" ? { url: g } : g,
  );
  for (const url of cli.gateways) gateways.push({ url });

  // Marketplace: CLI flag wins; then the file; then ON when no other source
  // is configured (zero-config default — a server with no sources is useless),
  // otherwise off.
  const fileMarketplace =
    typeof file.marketplace === "boolean"
      ? file.marketplace
        ? {}
        : undefined
      : file.marketplace;
  const nothingConfigured =
    gateways.length === 0 && Object.keys(file.mcpServers ?? {}).length === 0;
  let marketplace: { apiUrl?: string } | undefined;
  if (cli.marketplace === true) marketplace = fileMarketplace ?? {};
  else if (cli.marketplace === false) marketplace = undefined;
  else if (file.marketplace !== undefined) marketplace = fileMarketplace;
  else if (nothingConfigured) marketplace = {};
  if (marketplace && cli.apiUrl) marketplace = { ...marketplace, apiUrl: cli.apiUrl };

  const envBudget = parseEnvBudget(env.BUDGET_SATS);
  const budget: Partial<Record<string, number>> = { ...(file.budget ?? {}) };
  let budgetSatSource: ResolvedConfig["budgetSatSource"] =
    budget.sat !== undefined ? "file" : undefined;
  if (budget.sat === undefined && envBudget !== undefined) {
    budget.sat = envBudget;
    budgetSatSource = "env";
  }
  if (cli.budgetSats !== undefined) {
    budget.sat = cli.budgetSats;
    budgetSatSource = "flag";
  }

  const maxPerCall: Partial<Record<string, number>> = { ...(file.maxPerCall ?? {}) };
  if (cli.maxPerCallSats !== undefined) maxPerCall.sat = cli.maxPerCallSats;

  // Receipts: flag > file > RECEIPTS_PATH env. "default"/true = the store's
  // default path. Off unless one of them opts in.
  let receipts: ResolvedConfig["receipts"];
  const envReceipts = env.RECEIPTS_PATH?.trim();
  if (file.receipts === true) receipts = {};
  else if (typeof file.receipts === "string") receipts = { path: expandTilde(file.receipts) };
  if (receipts === undefined && envReceipts) {
    receipts = envReceipts === "default" ? {} : { path: expandTilde(envReceipts) };
  }
  if (cli.receiptsPath !== undefined) {
    receipts = cli.receiptsPath === "default" ? {} : { path: expandTilde(cli.receiptsPath) };
  }

  return {
    marketplace,
    gateways,
    mcpServers: file.mcpServers ?? {},
    budget,
    maxPerCall,
    budgetSatSource,
    configPath: path,
    namespace: file.namespace ?? "prefix",
    telemetry: file.telemetry ?? false,
    receipts,
  };
}

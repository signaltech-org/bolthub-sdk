import type { ToolResult } from "@bolthub/pay";

/** A tool as exposed by a source, before namespacing. */
export interface SourceTool {
  /** Source-local name, `[a-zA-Z0-9_-]+`. The aggregator may prefix it. */
  name: string;
  description?: string;
  /** Raw JSON Schema, forwarded to the upstream client byte-for-byte. */
  inputSchema: Record<string, unknown>;
}

/**
 * One provider of tools behind the unified server. Three kinds exist:
 *
 * - `marketplace` — the bolthub directory meta-tools (search/details/call…)
 * - `gateway`     — one L402 gateway's OpenAPI operations as tools
 * - `mcp`         — a downstream MCP server proxied through (paid via TPP)
 *
 * Lifecycle: `init()` once at startup (a throwing source is skipped with a
 * warning; the rest keep serving), `listTools()` snapshots after init,
 * `callTool()` per request, `close()` at teardown.
 */
export interface ToolSource {
  /** Unique namespacing key: config key, gateway slug, or `"marketplace"`. */
  readonly key: string;
  readonly kind: "gateway" | "marketplace" | "mcp";
  /**
   * `false` → tools are exposed unprefixed even in prefix mode (the
   * marketplace meta-tools are the server's "native" surface and
   * cross-reference each other by bare name).
   */
  readonly namespaced: boolean;
  /** Connect / fetch spec / list downstream tools. Called once at startup. */
  init(): Promise<void>;
  /** Post-init snapshot. v1 does not react to downstream list changes. */
  listTools(): SourceTool[];
  /**
   * Invoke by SOURCE-LOCAL name. Payment happens inside the source via the
   * shared payment services; budget refusals throw (`PaymentBudgetError` /
   * `L402BudgetError`) and the router turns them into a clean error result.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

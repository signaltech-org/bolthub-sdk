/**
 * Merge every source's tools under one surface and route calls back to the
 * owning source.
 *
 * Prefix mode (default): namespaced sources expose `key__toolName`;
 * non-namespaced sources (the marketplace meta-tools) stay bare. Collisions
 * are impossible by construction — config keys may not contain `__`, so
 * every prefixed name has one and bare meta-tool names never do.
 *
 * Flat mode: every tool keeps its bare name; ANY collision (including with
 * a meta-tool) is a hard startup error naming both owners — a tool is never
 * silently shadowed.
 *
 * Routing uses an exact-match map built at startup, never string splitting.
 */

import type { SourceTool, ToolSource } from "./sources/source.js";

export const NAMESPACE_SEPARATOR = "__";

export interface AggregatedTool extends SourceTool {
  /** The name the upstream MCP client sees. */
  publicName: string;
}

export interface Aggregate {
  tools: AggregatedTool[];
  route: Map<string, { source: ToolSource; realName: string }>;
}

export function buildAggregate(
  sources: ToolSource[],
  namespace: "prefix" | "flat",
): Aggregate {
  const tools: AggregatedTool[] = [];
  const route = new Map<string, { source: ToolSource; realName: string }>();
  const owners = new Map<string, string>(); // publicName → source key, for error messages

  for (const source of sources) {
    for (const tool of source.listTools()) {
      const publicName =
        namespace === "prefix" && source.namespaced
          ? `${source.key}${NAMESPACE_SEPARATOR}${tool.name}`
          : tool.name;

      const existing = owners.get(publicName);
      if (existing !== undefined) {
        throw new Error(
          `Tool name collision: "${publicName}" is exposed by both "${existing}" and "${source.key}".` +
            (namespace === "flat"
              ? ` Use namespace: "prefix" (the default), or rename one source's key.`
              : ` Give one gateway/server a distinct key in the config.`),
        );
      }
      owners.set(publicName, source.key);
      tools.push({ ...tool, publicName });
      route.set(publicName, { source, realName: tool.name });
    }
  }

  return { tools, route };
}

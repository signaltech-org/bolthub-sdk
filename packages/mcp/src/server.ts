/**
 * The upstream MCP server: the LOW-LEVEL `Server` (not `McpServer`) with raw
 * request handlers, so downstream `inputSchema`s pass through byte-for-byte —
 * `McpServer.registerTool` would force a lossy JSON-Schema → zod round trip.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PaymentBudgetError, L402BudgetError } from "@bolthub/pay";
import type { Aggregate } from "./aggregate.js";

export interface UnifiedServerOptions {
  version: string;
}

export function createUnifiedServer(aggregate: Aggregate, options: UnifiedServerOptions): Server {
  const server = new Server(
    { name: "bolthub", version: options.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: aggregate.tools.map((t) => ({
      name: t.publicName,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const resolved = aggregate.route.get(req.params.name);
    if (!resolved) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await resolved.source.callTool(
        resolved.realName,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      );
      return result as { content: { type: "text"; text: string }[]; isError?: boolean };
    } catch (err) {
      // Budget refusals are a clean tool result, not a protocol crash — the
      // agent should read "payment refused" and adapt. Anything else (real
      // downstream/transport failures) surfaces as a normal error result.
      if (err instanceof PaymentBudgetError || err instanceof L402BudgetError) {
        return {
          content: [{ type: "text" as const, text: `Payment refused: ${err.message}` }],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function serveStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import type { McpToolDefinition } from "./openapi-to-tools.js";
import { executeToolCall } from "./tool-handler.js";
import { loadActionManifest, wrapWithReceiptGate } from "./receipt-gate.js";
import type { L402Client } from "@bolthub/agent";

/**
 * Convert a simple JSON Schema type descriptor to its Zod equivalent.
 * Supports string, number, integer, boolean, object, and array types.
 * @internal
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type as string | undefined;
  if (type === "string") return z.string().optional().describe((schema.description as string) ?? "");
  if (type === "number" || type === "integer") return z.number().optional().describe((schema.description as string) ?? "");
  if (type === "boolean") return z.boolean().optional().describe((schema.description as string) ?? "");
  if (type === "object") return z.record(z.unknown()).optional().describe((schema.description as string) ?? "");
  if (type === "array") return z.array(z.unknown()).optional().describe((schema.description as string) ?? "");
  return z.unknown().optional();
}

/**
 * Build a Zod shape from a tool's JSON Schema properties, applying
 * required/optional status to each field.
 * @internal
 */
export function buildZodShape(tool: McpToolDefinition): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const props = tool.inputSchema.properties;
  const required = new Set(tool.inputSchema.required ?? []);

  for (const [key, prop] of Object.entries(props)) {
    const propSchema = prop as Record<string, unknown>;
    let zodType = jsonSchemaToZod(propSchema);
    if (required.has(key)) {
      if (zodType instanceof z.ZodOptional) zodType = zodType.unwrap();
    }
    shape[key] = zodType;
  }

  return shape;
}

/**
 * Register all discovered OpenAPI operations as MCP tools and start
 * the stdio-based MCP server. Blocks until the transport disconnects.
 */
export async function startMcpServer(
  tools: McpToolDefinition[],
  l402Client: L402Client,
  serverName: string,
): Promise<void> {
  // Source the version from package.json so `serverInfo.version`
  // reported to MCP clients never drifts from the published npm
  // version. Bun's bundler inlines this JSON import at build time.
  const server = new McpServer({
    name: serverName,
    version: pkg.version,
  });

  // OPT-IN: when an operator points BOLTHUB_AGENT_ACTIONS at an Action Risk
  // Manifest, tools it marks `receipt_required` gain a Receipt Required gate in
  // front of their L402 auto-payment. When unset (the default), `manifest` is
  // null and `wrapWithReceiptGate` returns the handler unchanged — no gate, no
  // behavior change. See packages/mcp-bridge/src/receipt-gate.ts.
  const actionManifest = loadActionManifest();

  for (const tool of tools) {
    const zodShape = buildZodShape(tool);

    const handler = (args: Record<string, unknown>) =>
      executeToolCall(tool, args, l402Client);

    server.tool(
      tool.name,
      tool.description,
      zodShape,
      (args) => wrapWithReceiptGate(tool, handler, actionManifest)(args as Record<string, unknown>),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

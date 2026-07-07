/**
 * GatewaySource — one L402 gateway's OpenAPI operations as tools (the old
 * `@bolthub/mcp-bridge`, as a source). Paid over HTTP 402 via the shared
 * `L402Client`; free endpoints work without a wallet.
 */

import { fetchOpenApiSpec, convertOpenApiToTools, extractSlug } from "./openapi-to-tools.js";
import type { McpToolDefinition } from "./openapi-to-tools.js";
import { executeToolCall } from "./gateway-call.js";
import type { SourceTool, ToolSource } from "./source.js";
import type { PaymentServices } from "../payment.js";
import type { ToolResult } from "@bolthub/pay";

export class GatewaySource implements ToolSource {
  readonly kind = "gateway" as const;
  readonly namespaced = true;
  readonly key: string;
  private readonly url: string;
  private readonly services: PaymentServices;
  private byName = new Map<string, McpToolDefinition>();

  constructor(entry: { url: string; key?: string }, services: PaymentServices) {
    this.url = entry.url;
    this.key = entry.key ?? extractSlug(entry.url);
    this.services = services;
  }

  async init(): Promise<void> {
    const spec = await fetchOpenApiSpec(this.url);
    const tools = convertOpenApiToTools(spec, this.url);
    if (tools.length === 0) {
      throw new Error(`no tools found in the OpenAPI spec at ${this.url}`);
    }
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  listTools(): SourceTool[] {
    return [...this.byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as unknown as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.byName.get(name);
    if (!tool) throw new Error(`Unknown tool "${name}" on gateway ${this.key}`);
    return executeToolCall(tool, args, this.services.l402Client);
  }

  async close(): Promise<void> {
    // Nothing held open; sessions live in the shared FileSessionStore.
  }
}

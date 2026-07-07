/**
 * McpServerSource — proxy a downstream MCP server (the mcp-proxy design, as
 * a source): free tools forward untouched, and a TPP payment challenge in a
 * result's `_meta` is paid via the shared `ToolClient` and retried, inside
 * the shared budget.
 *
 * Local servers (`command`) are spawned over stdio and owned by this source;
 * remote servers (`url`) connect over Streamable HTTP, falling back to SSE
 * for older servers.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerEntry } from "../config.js";
import type { SourceTool, ToolSource } from "./source.js";
import type { PaymentServices } from "../payment.js";
import { log } from "../log.js";
import type { ToolResult } from "@bolthub/pay";

const PROXY_CLIENT_VERSION = "0.1.0";

/**
 * The slice of the SDK `Client` this source needs — structural, so tests can
 * inject a downstream without spawning processes or opening sockets.
 */
export interface DownstreamClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown }[];
    nextCursor?: string;
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export class McpServerSource implements ToolSource {
  readonly kind = "mcp" as const;
  readonly namespaced = true;
  readonly key: string;
  private readonly entry: McpServerEntry;
  private readonly services: PaymentServices;
  private readonly clientFactory?: () => Promise<DownstreamClient>;
  private client?: DownstreamClient;
  private tools: SourceTool[] = [];

  constructor(
    key: string,
    entry: McpServerEntry,
    services: PaymentServices,
    clientFactory?: () => Promise<DownstreamClient>,
  ) {
    this.key = key;
    this.entry = entry;
    this.services = services;
    this.clientFactory = clientFactory;
  }

  async init(): Promise<void> {
    this.client = this.clientFactory ? await this.clientFactory() : await this.connect();

    // listTools paginates; loop on nextCursor or tools silently truncate.
    const tools: SourceTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          description: t.description,
          // Forward the downstream schema BYTE-FOR-BYTE — never round-trip
          // through zod (lossy). This is why the upstream uses the low-level
          // Server.
          inputSchema: t.inputSchema as unknown as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  private async connect(): Promise<Client> {
    const makeClient = () =>
      new Client({ name: `bolthub-mcp:${this.key}`, version: PROXY_CLIENT_VERSION });

    if ("command" in this.entry) {
      const client = makeClient();
      const transport = new StdioClientTransport({
        command: this.entry.command,
        args: this.entry.args ?? [],
        env: { ...getDefaultEnvironment(), ...(this.entry.env ?? {}) },
        cwd: this.entry.cwd,
        stderr: "inherit", // downstream diagnostics stay visible (and off stdout)
      });
      await client.connect(transport);
      return client;
    }

    const url = new URL(this.entry.url);
    const requestInit = this.entry.headers ? { headers: this.entry.headers } : undefined;
    try {
      const client = makeClient();
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
      return client;
    } catch (err) {
      log(`${this.key}: streamable HTTP failed (${err instanceof Error ? err.message : err}), trying SSE`);
      const client = makeClient();
      await client.connect(new SSEClientTransport(url, { requestInit }));
      return client;
    }
  }

  listTools(): SourceTool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client) throw new Error(`Downstream server "${this.key}" is not connected`);
    const client = this.client;

    // With a wallet: ToolClient does the whole dance (call → detect
    // challenge → budget-gate → pay → retry with proof); free tools return
    // on the first call. Without one: forward raw — free tools work, paid
    // ones surface the challenge result for the agent to read.
    if (this.services.toolClient) {
      return this.services.toolClient.callTool(client, name, args);
    }
    return client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}

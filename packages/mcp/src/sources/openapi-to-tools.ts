import { normalizeJsonSchemaType } from "@bolthub/shared";

/** A single MCP tool derived from an OpenAPI operation. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  meta: {
    url: string;
    method: string;
    path: string;
  };
}

interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: { type?: string; description?: string };
  description?: string;
  example?: unknown;
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown>; example?: unknown }>;
  };
  "x-l402-pricing"?: {
    model?: string;
    priceSats?: number;
    tokenBudget?: number;
    durationMinutes?: number;
    unitCostSats?: number;
  };
}

interface OpenApiSpec {
  info?: { title?: string; description?: string };
  servers?: { url: string }[];
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

/**
 * Derive the default namespace key for a gateway URL (`btc-intel` from
 * `https://btc-intel.gw.bolthub.ai`). Falls back to `"api"` — two gateways
 * hitting the fallback collide at startup; set an explicit `key` in config.
 */
export function extractSlug(gatewayUrl: string): string {
  try {
    const url = new URL(gatewayUrl);
    const subdomainMatch = url.hostname.match(/^([^.]+)\.gw\./);
    if (subdomainMatch) return subdomainMatch[1];

    const pathMatch = url.pathname.match(/\/gw\/([^/]+)/);
    if (pathMatch) return pathMatch[1];
  } catch { /* ignore invalid URLs */ }
  return "api";
}

/**
 * Source-LOCAL tool name for an operation (`get_v1_history_candles`). The
 * aggregator prefixes it with the gateway's key (`btc-intel__get_…`); the
 * old mcp-bridge slug prefix moved there.
 * @internal
 */
export function buildToolName(method: string, path: string): string {
  const normalized = path.replace(/\//g, "_").replace(/[^a-zA-Z0-9_]/g, "");
  return `${method.toLowerCase()}${normalized}`;
}

/** @internal */
export function buildInputSchema(op: OpenApiOperation, method: string) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  if (op.parameters) {
    for (const param of op.parameters) {
      if (param.in === "query" || param.in === "path") {
        properties[param.name] = {
          type: normalizeJsonSchemaType(param.schema?.type),
          description: param.description ?? `${param.in} parameter`,
          ...(param.example !== undefined && { default: param.example }),
        };
        if (param.in === "path" || param.required) required.push(param.name);
      }
    }
  }

  const upperMethod = method.toUpperCase();
  if (upperMethod !== "GET" && upperMethod !== "HEAD" && op.requestBody) {
    const jsonContent = op.requestBody.content?.["application/json"];
    if (jsonContent?.schema) {
      properties.body = jsonContent.schema;
    } else {
      properties.body = { type: "object", description: "JSON request body" };
    }
    if (op.requestBody.required) required.push("body");
  }

  if (Object.keys(properties).length === 0) {
    properties.query = {
      type: "string",
      description: "Optional query parameters as key=value&key2=value2",
    };
  }

  return {
    type: "object" as const,
    properties,
    ...(required.length > 0 && { required }),
  };
}

/** @internal */
export function buildDescription(op: OpenApiOperation, method: string, path: string): string {
  let desc = op.summary || op.description || `${method.toUpperCase()} ${path}`;
  const pricing = op["x-l402-pricing"];
  if (pricing?.priceSats) {
    switch (pricing.model) {
      case "per_kb":
        desc += ` (${pricing.unitCostSats ?? pricing.priceSats} sats/KB, ${pricing.priceSats} sats deposit)`;
        break;
      case "token_bucket":
        desc += ` (${pricing.priceSats} sats for ${pricing.tokenBudget ?? "N"} requests)`;
        break;
      case "time_pass":
        desc += ` (${pricing.priceSats} sats for ${pricing.durationMinutes ?? "N"} minutes)`;
        break;
      case "metered":
        desc += ` (${pricing.priceSats} sats deposit, ${pricing.unitCostSats ?? "N"} sats/request)`;
        break;
      default:
        desc += ` (${pricing.priceSats} sats/request)`;
    }
  }
  return desc;
}

/** Fetch the OpenAPI spec from a gateway's `.well-known/openapi.json` endpoint. */
export async function fetchOpenApiSpec(gatewayUrl: string): Promise<OpenApiSpec> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const url = `${base}/.well-known/openapi.json`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${url}: ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<OpenApiSpec>;
}

/** Convert all operations in an OpenAPI spec into MCP tool definitions. */
export function convertOpenApiToTools(
  spec: OpenApiSpec,
  gatewayUrl: string,
): McpToolDefinition[] {
  const baseUrl = gatewayUrl.replace(/\/+$/, "");
  const tools: McpToolDefinition[] = [];

  if (!spec.paths) return tools;

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (typeof operation !== "object" || operation === null) continue;

      tools.push({
        name: buildToolName(method, path),
        description: buildDescription(operation, method, path),
        inputSchema: buildInputSchema(operation, method),
        meta: {
          url: `${baseUrl}${path}`,
          method: method.toUpperCase(),
          path,
        },
      });
    }
  }

  return tools;
}

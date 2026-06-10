/**
 * Mirrors `EndpointParameter` in `@bolthub/db` — kept here so API and clients avoid DB imports.
 */
export type EndpointParameterMeta = {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  type?: string;
  default?: unknown;
  example?: unknown;
  enum?: unknown[];
};

const GENERIC_QUERY_DESC = "Query parameters as key=value&key2=value2";

/** Maps publisher / OpenAPI type strings to JSON Schema `type` values. */
export function normalizeJsonSchemaType(t: string | undefined): string {
  const x = (t ?? "string").toLowerCase().trim();
  if (x === "integer" || x === "number" || x === "boolean" || x === "string" || x === "array" || x === "object") {
    return x;
  }
  return "string";
}

function propertyForBoltParam(p: EndpointParameterMeta): Record<string, unknown> {
  const prop: Record<string, unknown> = {
    type: normalizeJsonSchemaType(p.type),
    description: p.description ?? `${p.in} parameter`,
  };
  if (p.enum !== undefined && p.enum.length > 0) prop.enum = p.enum;
  if (p.default !== undefined) prop.default = p.default;
  else if (p.example !== undefined) prop.default = p.example;
  return prop;
}

/**
 * Builds a JSON Schema object for MCP tool `inputSchema` from stored endpoint metadata
 * (and optional example request fallback), matching the intent of OpenAPI-derived tools.
 */
export function buildMcpToolInputSchema(
  parameters: EndpointParameterMeta[] | null | undefined,
  method: string,
  exampleRequest: Record<string, unknown> | null | undefined,
): {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const list = parameters ?? [];
  for (const p of list) {
    const loc = (p.in ?? "").toLowerCase();
    if (loc !== "path" && loc !== "query" && loc !== "header") continue;
    properties[p.name] = propertyForBoltParam({ ...p, in: loc });
    if (loc === "path" || p.required) required.push(p.name);
  }

  if (exampleRequest) {
    const pathParams = exampleRequest.path_parameters;
    if (pathParams && typeof pathParams === "object" && !Array.isArray(pathParams)) {
      for (const key of Object.keys(pathParams as Record<string, unknown>)) {
        if (properties[key] !== undefined) continue;
        properties[key] = {
          type: "string",
          description: `Inferred from example path_parameters.${key}`,
        };
        required.push(key);
      }
    }
    const queryParams = exampleRequest.query_parameters;
    if (queryParams && typeof queryParams === "object" && !Array.isArray(queryParams)) {
      for (const key of Object.keys(queryParams as Record<string, unknown>)) {
        if (properties[key] !== undefined) continue;
        properties[key] = {
          type: "string",
          description: `Inferred from example query_parameters.${key}`,
        };
      }
    }
  }

  const upper = method.toUpperCase();
  if (upper !== "GET" && upper !== "HEAD") {
    properties.body = { type: "object", description: "JSON request body" };
  }

  const hasNamedPathQueryHeader = Object.keys(properties).some((k) => k !== "body");
  if (!hasNamedPathQueryHeader) {
    properties.query = { type: "string", description: GENERIC_QUERY_DESC };
  }

  const uniqRequired = [...new Set(required)];
  return {
    type: "object",
    properties,
    ...(uniqRequired.length > 0 ? { required: uniqRequired } : {}),
  };
}

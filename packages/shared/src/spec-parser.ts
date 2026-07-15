import yaml from "js-yaml";

// API-spec parser (OpenAPI/Swagger, Postman collection, plain JSON array).
// Lives in @bolthub/shared so the dashboard ApiImporter and the @bolthub/mcp
// `list_api` tool parse specs with the exact same logic (GR-T2). Pure
// string-in / endpoints-out: no fetching here — URL retrieval stays behind
// the API's SSRF-safe `POST /spec-import/fetch` proxy on both paths.

export interface ImportedParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  description?: string;
  required?: boolean;
  type?: string;
  example?: unknown;
  enum?: unknown[];
}

export interface ImportedEndpoint {
  method: string;
  path: string;
  originUrl?: string;
  title?: string;
  description?: string;
  docsUrl?: string;
  exampleRequest?: Record<string, unknown>;
  exampleResponse?: Record<string, unknown>;
  parameters?: ImportedParameter[];
}

export type DetectedFormat = "openapi" | "postman" | "json";

export const FORMAT_LABELS: Record<DetectedFormat, string> = {
  openapi: "OpenAPI / Swagger",
  postman: "Postman Collection",
  json: "JSON",
};

function detectFormat(data: unknown): DetectedFormat | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (obj.openapi || obj.swagger) return "openapi";

  const info = obj.info as Record<string, unknown> | undefined;
  if (
    info &&
    (typeof info._postman_id === "string" ||
      (typeof info.schema === "string" && info.schema.includes("postman")))
  ) {
    return "postman";
  }

  if (Array.isArray(data)) return "json";

  return null;
}

function extractOpenApiExample(
  content: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!content) return undefined;
  const json = content["application/json"] as Record<string, unknown> | undefined;
  if (!json) return undefined;
  if (json.example && typeof json.example === "object") return json.example as Record<string, unknown>;
  const schema = json.schema as Record<string, unknown> | undefined;
  if (schema?.example && typeof schema.example === "object") return schema.example as Record<string, unknown>;
  return undefined;
}

/**
 * First usable example for a parameter, reading every shape a spec may use,
 * newest-first:
 *   - `parameter.example`            (OpenAPI 3.0 singular)
 *   - `parameter.examples`           (object map { name: { value } }, 3.0/3.1)
 *   - `schema.example`               (singular)
 *   - `schema.examples`              (ARRAY, JSON-Schema / OpenAPI 3.1)
 * Previously only the two singular `example` fields were read, so a param
 * that ships only `schema.examples: [...]` (3.1) imported with no value and
 * never made it into the request builder or the captured sample.
 */
function firstParamExample(
  p: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): unknown {
  if (p.example !== undefined) return p.example;
  const pExamples = p.examples;
  if (pExamples && typeof pExamples === "object" && !Array.isArray(pExamples)) {
    const first = Object.values(pExamples as Record<string, unknown>)[0];
    if (first && typeof first === "object" && "value" in first) {
      return (first as { value: unknown }).value;
    }
  }
  if (schema?.example !== undefined) return schema.example;
  if (Array.isArray(schema?.examples) && schema.examples.length > 0) return schema.examples[0];
  return undefined;
}

function parseOpenApiParams(
  pathParams: unknown[] | undefined,
  opParams: unknown[] | undefined,
): ImportedParameter[] {
  const merged = new Map<string, ImportedParameter>();

  for (const raw of [...(pathParams || []), ...(opParams || [])]) {
    const p = raw as Record<string, unknown>;
    if (!p || typeof p.name !== "string") continue;
    const loc = p.in as string;
    if (!["path", "query", "header"].includes(loc)) continue;
    const schema = p.schema as Record<string, unknown> | undefined;
    const enumValues = (p.enum ?? schema?.enum) as unknown[] | undefined;
    merged.set(`${loc}:${p.name}`, {
      name: p.name,
      in: loc as "path" | "query" | "header",
      description: (p.description as string) || undefined,
      required: (p.required as boolean) || loc === "path",
      type: (schema?.type as string) || undefined,
      example: firstParamExample(p, schema),
      enum: Array.isArray(enumValues) && enumValues.length > 0 ? enumValues : undefined,
    });
  }

  return [...merged.values()];
}

function parseOpenApi(data: Record<string, unknown>): ImportedEndpoint[] {
  const endpoints: ImportedEndpoint[] = [];
  const servers = (data.servers as Array<{ url: string }>) || [];
  const baseUrl = servers[0]?.url || "";

  const paths = data.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return endpoints;

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathLevelParams = (pathItem as Record<string, unknown>).parameters as unknown[] | undefined;

    for (const [method, details] of Object.entries(pathItem)) {
      // bolthub lists data (GET/HEAD) and computation (POST) only; skip
      // mutating verbs on import.
      if (!["get", "post", "head"].includes(method.toLowerCase())) continue;
      const spec = details as Record<string, unknown>;
      const operationDocs =
        (spec.externalDocs as { url?: string } | undefined)?.url ||
        (data.externalDocs as { url?: string } | undefined)?.url;

      const requestBody = spec.requestBody as Record<string, unknown> | undefined;
      const responses = spec.responses as Record<string, Record<string, unknown>> | undefined;
      const exampleRequest = extractOpenApiExample(requestBody?.content as Record<string, unknown> | undefined);
      const successResponse = responses?.["200"] || responses?.["201"];
      const exampleResponse = extractOpenApiExample(successResponse?.content as Record<string, unknown> | undefined);

      const parameters = parseOpenApiParams(
        pathLevelParams,
        spec.parameters as unknown[] | undefined,
      );

      endpoints.push({
        method: method.toUpperCase(),
        path,
        originUrl: baseUrl ? baseUrl.replace(/\/$/, "") : undefined,
        // Title prefers the short `summary`, description prefers the
        // longer `description`. They must not share a fallback or an
        // operation with only one of the two ends up showing the same
        // text in both fields (the duplicate-text bug). When only
        // `summary` exists it becomes the title and the description is
        // left empty rather than echoing it.
        title: (spec.summary || spec.operationId || "") as string,
        description: (spec.description || "") as string,
        docsUrl: operationDocs,
        exampleRequest,
        exampleResponse,
        parameters: parameters.length > 0 ? parameters : undefined,
      });
    }
  }

  return endpoints;
}

function resolvePostmanVars(raw: string, vars: Map<string, string>): string {
  return raw.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars.get(key) || "");
}

function normalizePathParams(path: string): string {
  return path.replace(/:([a-zA-Z_]\w*)/g, "{$1}");
}

function extractPathParams(path: string): ImportedParameter[] {
  const params: ImportedParameter[] = [];
  const regex = /\{(\w+)\}/g;
  let match;
  while ((match = regex.exec(path)) !== null) {
    params.push({ name: match[1], in: "path", required: true });
  }
  return params;
}

function postmanVarsToPathParams(raw: string): string {
  return raw.replace(/\{\{([^}]+)\}\}/g, "{$1}");
}

interface PostmanVariable {
  key?: string;
  value?: string;
  type?: string;
  description?: string;
}

function buildCollectionVarMeta(
  data: Record<string, unknown>,
): Map<string, { value: string; description?: string }> {
  const meta = new Map<string, { value: string; description?: string }>();
  if (Array.isArray(data.variable)) {
    for (const v of data.variable as PostmanVariable[]) {
      if (v.key) {
        meta.set(v.key, {
          value: v.value || "",
          description: v.description || undefined,
        });
      }
    }
  }
  return meta;
}

function synthesizeExampleFromParams(
  parameters: ImportedParameter[],
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const queryParams = parameters.filter(
    (p) => p.in === "query" && p.example != null && !p.name.startsWith("force"),
  );
  const pathParams = parameters.filter(
    (p) => p.in === "path" && p.example != null,
  );

  if (queryParams.length === 0 && pathParams.length === 0) return undefined;

  const example: Record<string, unknown> = {};

  if (queryParams.length > 0) {
    const queryObj: Record<string, unknown> = {};
    for (const p of queryParams) queryObj[p.name] = p.example;
    example.query_parameters = queryObj;
  }

  if (pathParams.length > 0) {
    const pathObj: Record<string, unknown> = {};
    for (const p of pathParams) pathObj[p.name] = p.example;
    example.path_parameters = pathObj;
  }

  if (body?.mode === "formdata" && Array.isArray(body.formdata)) {
    const formObj: Record<string, unknown> = {};
    for (const f of body.formdata as Array<{ key?: string; value?: string; description?: string }>) {
      if (f.key) formObj[f.key] = f.value || "";
    }
    if (Object.keys(formObj).length > 0) example.form_data = formObj;
  }

  if (body?.mode === "urlencoded" && Array.isArray(body.urlencoded)) {
    const formObj: Record<string, unknown> = {};
    for (const f of body.urlencoded as Array<{ key?: string; value?: string }>) {
      if (f.key) formObj[f.key] = f.value || "";
    }
    if (Object.keys(formObj).length > 0) example.url_encoded = formObj;
  }

  return Object.keys(example).length > 0 ? example : undefined;
}

function parsePostman(data: Record<string, unknown>): ImportedEndpoint[] {
  const endpoints: ImportedEndpoint[] = [];

  const vars = new Map<string, string>();
  const varMeta = buildCollectionVarMeta(data);
  for (const [k, v] of varMeta) {
    if (v.value) vars.set(k, v.value);
  }

  function processItem(item: Record<string, unknown>) {
    if (Array.isArray(item.item)) {
      (item.item as Record<string, unknown>[]).forEach(processItem);
      return;
    }

    const req = item.request as Record<string, unknown> | undefined;
    if (!req) return;

    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const url = req.url;
    let path = "/";
    const parameters: ImportedParameter[] = [];
    let originUrl: string | undefined;

    if (typeof url === "string") {
      const resolved = vars.size > 0 ? resolvePostmanVars(url, vars) : url;
      try {
        const parsed = new URL(resolved);
        originUrl = parsed.origin;
      } catch { /* ignore */ }
      const afterProtocol = url.indexOf("//");
      const pathStart = afterProtocol > -1
        ? url.indexOf("/", afterProtocol + 2)
        : url.indexOf("/");
      if (pathStart > -1) {
        path = postmanVarsToPathParams(url.substring(pathStart));
      }
    } else if (url && typeof url === "object") {
      const urlObj = url as Record<string, unknown>;

      if (Array.isArray(urlObj.path)) {
        path = "/" + (urlObj.path as string[])
          .map((seg: string) => postmanVarsToPathParams(seg))
          .join("/");
      }

      let hostUrl = "";
      if (urlObj.protocol && Array.isArray(urlObj.host)) {
        const proto = (urlObj.protocol as string).replace(/:$/, "");
        const hostRaw = (urlObj.host as string[]).join(".");
        const hostResolved = vars.size > 0 ? resolvePostmanVars(hostRaw, vars) : hostRaw;
        hostUrl = `${proto}://${hostResolved}`;
      } else if (Array.isArray(urlObj.host)) {
        const hostRaw = (urlObj.host as string[]).join(".");
        const hostResolved = vars.size > 0 ? resolvePostmanVars(hostRaw, vars) : hostRaw;
        hostUrl = hostResolved.startsWith("http") ? hostResolved : `https://${hostResolved}`;
      } else {
        const rawStr = (urlObj.raw as string) || "";
        const resolved = vars.size > 0 ? resolvePostmanVars(rawStr, vars) : rawStr;
        try {
          const parsed = new URL(resolved);
          hostUrl = parsed.origin;
        } catch { /* ignore */ }
      }

      if (hostUrl) {
        try {
          const parsed = new URL(hostUrl);
          originUrl = parsed.origin;
        } catch { /* ignore */ }
      }

      if (Array.isArray(urlObj.query)) {
        for (const q of urlObj.query as Array<{ key?: string; description?: string; value?: string; disabled?: boolean }>) {
          if (q.key) {
            parameters.push({
              name: q.key,
              in: "query",
              description: q.description || undefined,
              required: !q.disabled,
              example: q.value || undefined,
            });
          }
        }
      }

      if (Array.isArray(urlObj.variable)) {
        for (const v of urlObj.variable as Array<{ key?: string; description?: string; value?: string }>) {
          if (v.key) {
            parameters.push({
              name: v.key,
              in: "path",
              description: v.description || undefined,
              required: true,
              example: v.value || undefined,
            });
          }
        }
      }
    }

    path = normalizePathParams(path);

    const barePathParams = extractPathParams(path).filter(
      (p) => !parameters.some((existing) => existing.in === "path" && existing.name === p.name),
    );
    for (const bp of barePathParams) {
      const collMeta = varMeta.get(bp.name);
      if (collMeta) {
        bp.description = collMeta.description;
        bp.example = collMeta.value || undefined;
      }
    }
    parameters.push(...barePathParams);

    for (const p of parameters) {
      if (p.in === "path" && !p.description && !p.example) {
        const collMeta = varMeta.get(p.name);
        if (collMeta) {
          if (!p.description && collMeta.description) p.description = collMeta.description;
          if (!p.example && collMeta.value) p.example = collMeta.value;
        }
      }
    }

    if (Array.isArray(req.header)) {
      for (const h of req.header as Array<{ key?: string; value?: string; description?: string; disabled?: boolean }>) {
        if (h.key && !["Content-Type", "Accept", "Authorization"].includes(h.key)) {
          parameters.push({
            name: h.key,
            in: "header",
            description: h.description || undefined,
            required: !h.disabled,
            example: h.value || undefined,
          });
        }
      }
    }

    let exampleRequest: Record<string, unknown> | undefined;
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.raw && typeof body.raw === "string") {
      const rawStr = vars.size > 0 ? resolvePostmanVars(body.raw as string, vars) : (body.raw as string);
      try {
        exampleRequest = JSON.parse(rawStr);
      } catch { /* not JSON */ }
    }

    if (!exampleRequest) {
      exampleRequest = synthesizeExampleFromParams(parameters, body);
    }

    let exampleResponse: Record<string, unknown> | undefined;
    const responses = item.response as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(responses)) {
      const successResp = responses.find((r) => {
        const code = r.code as number | undefined;
        return code != null && code >= 200 && code < 300;
      }) || responses[0];

      if (successResp?.body && typeof successResp.body === "string") {
        try {
          exampleResponse = JSON.parse(successResp.body as string);
        } catch { /* not JSON */ }
      }
    }

    // Title is the Postman item name; description is the request's
    // own description. Don't fall back to the name here — that just
    // duplicates the title in both fields.
    const description = (req.description as string) || "";

    endpoints.push({
      method,
      path,
      originUrl,
      title: (item.name as string) || "",
      description,
      exampleRequest,
      exampleResponse,
      parameters: parameters.length > 0 ? parameters : undefined,
    });
  }

  ((data.item as Record<string, unknown>[]) || []).forEach(processItem);
  return endpoints;
}

function parseJson(data: unknown): ImportedEndpoint[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (item) =>
        item && typeof item === "object" && typeof item.method === "string" && typeof item.path === "string"
    )
    .map((item) => ({
      method: (item.method as string).toUpperCase(),
      path: item.path as string,
      originUrl: item.url || item.originUrl || item.origin_url || undefined,
      // Don't fall back description to the name/title — that
      // duplicates the title in both fields (the duplicate-text bug).
      title: item.title || item.name || "",
      description: item.description || "",
      docsUrl: item.docsUrl || item.docs_url || undefined,
    }));
}

export function deduplicateEndpoints(eps: ImportedEndpoint[]): {
  endpoints: ImportedEndpoint[];
  mergedCount: number;
} {
  const seen = new Map<string, number>();
  const unique: ImportedEndpoint[] = [];
  let mergedCount = 0;

  for (const ep of eps) {
    const key = `${ep.method}:${ep.path}`;
    const existingIdx = seen.get(key);

    if (existingIdx != null) {
      mergedCount++;
      const existing = unique[existingIdx];
      if (ep.parameters) {
        const merged = [...(existing.parameters ?? [])];
        for (const p of ep.parameters) {
          if (!merged.some((m) => m.in === p.in && m.name === p.name)) {
            merged.push(p);
          }
        }
        existing.parameters = merged;
      }
      if (!existing.title && ep.title) existing.title = ep.title;
      if (!existing.description && ep.description) existing.description = ep.description;
      if (!existing.exampleRequest && ep.exampleRequest) existing.exampleRequest = ep.exampleRequest;
      if (!existing.exampleResponse && ep.exampleResponse) existing.exampleResponse = ep.exampleResponse;
      if (!existing.docsUrl && ep.docsUrl) existing.docsUrl = ep.docsUrl;
    } else {
      seen.set(key, unique.length);
      unique.push({ ...ep, parameters: ep.parameters ? [...ep.parameters] : undefined });
    }
  }

  return { endpoints: unique, mergedCount };
}

export function parseFile(
  content: string,
  fileName: string,
): { format: DetectedFormat; endpoints: ImportedEndpoint[] } | null {
  let data: unknown;

  try {
    data = JSON.parse(content);
  } catch {
    if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) {
      try {
        data = yaml.load(content);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  const format = detectFormat(data);
  if (!format) return null;

  const obj = data as Record<string, unknown>;
  let endpoints: ImportedEndpoint[] = [];

  switch (format) {
    case "openapi":
      endpoints = parseOpenApi(obj);
      break;
    case "postman":
      endpoints = parsePostman(obj);
      break;
    case "json":
      endpoints = parseJson(data);
      break;
  }

  return endpoints.length > 0 ? { format, endpoints } : null;
}

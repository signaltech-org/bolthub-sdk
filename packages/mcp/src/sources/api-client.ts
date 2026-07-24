const DEFAULT_API_URL = "https://api.bolthub.ai";
const GATEWAY_DOMAIN = "gw.bolthub.ai";

/** A single endpoint within a directory listing. */
export interface DirectoryEndpoint {
  path: string;
  method: string;
  title: string | null;
  description: string | null;
  docsUrl: string | null;
  pricingModel: string | null;
  priceSats: number | null;
  tokenBudget: number | null;
  durationMinutes: number | null;
  unitCostSats: number | null;
  freeTryEnabled: boolean;
  /** Live SSE endpoint: the gateway streams its body unbuffered. */
  streaming?: boolean;
  exampleRequest: Record<string, unknown> | null;
  exampleResponse: Record<string, unknown> | null;
  parameters?: {
    name: string;
    in: string;
    description?: string;
    required?: boolean;
    type?: string;
    default?: unknown;
    example?: unknown;
    enum?: unknown[];
  }[] | null;
}

/** An API listing from the BoltHub directory. */
export interface DirectoryEntry {
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  gatewayDomain: string;
  endpointCount: number;
  endpoints: DirectoryEndpoint[];
}

interface DirectoryListResponse {
  entries: DirectoryEntry[];
  tags: string[];
  total: number;
  hasMore: boolean;
}

/** HTTP client for the BoltHub directory API. */
export class ApiClient {
  private apiUrl: string;

  /** @param apiUrl - Override the directory API base URL (defaults to `https://api.bolthub.ai`). */
  constructor(apiUrl?: string) {
    this.apiUrl = (apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  }

  /** Search the directory, optionally filtered by keyword and/or tag. */
  async searchApis(query?: string, tags?: string): Promise<DirectoryEntry[]> {
    const params = new URLSearchParams();
    if (query) params.set("search", query);
    if (tags) params.set("tag", tags);
    params.set("limit", "20");

    const url = `${this.apiUrl}/directory?${params.toString()}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Directory API returned ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as DirectoryListResponse;
    return data.entries;
  }

  /** Fetch full details (endpoints, pricing, examples) for a single API. */
  async getApiDetails(slug: string): Promise<DirectoryEntry> {
    const url = `${this.apiUrl}/directory/${encodeURIComponent(slug)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(`API "${slug}" not found in the bolthub directory`);
      }
      throw new Error(`Directory API returned ${resp.status}: ${await resp.text()}`);
    }
    return (await resp.json()) as DirectoryEntry;
  }

  /** Build the gateway URL for a given API slug and endpoint path. */
  getGatewayUrl(slug: string, path = "/"): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `https://${slug}.${GATEWAY_DOMAIN}${normalizedPath}`;
  }
}

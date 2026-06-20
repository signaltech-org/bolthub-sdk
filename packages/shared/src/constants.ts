export const PLATFORM_NAME = "bolthub";
/** Display wordmark for share cards / titles: the real domain, not the bare name. */
export const BRAND_WORDMARK = "bolthub.ai";
export const SITE_URL = "https://bolthub.ai";
export const API_URL = "https://api.bolthub.ai";
export const CONTACT_EMAIL = "contact@bolthub.ai";
export const LEGAL_EMAIL = "contact@bolthub.ai";
export const GATEWAY_DOMAIN = "gw.bolthub.ai";

export const OPERATOR_LEGAL_NAME = "Signal Tech Pty Ltd";
export const OPERATOR_ABN = "73 696 470 596";
export const OPERATOR_ADDRESS = "Sunshine Coast, QLD, Australia";

/**
 * Build the full gateway URL for a tenant endpoint.
 *
 * When NEXT_PUBLIC_GATEWAY_BASE_URL is set (local dev) the URL uses
 * path-based routing:  http://localhost:3001/gw/{slug}{path}
 *
 * Falls back to deriving the gateway base from NEXT_PUBLIC_API_URL when
 * it points to localhost (auto-detects local dev without extra config).
 *
 * Otherwise uses the production subdomain pattern:
 *   https://{slug}.gw.bolthub.ai{path}
 */
export function getGatewayUrl(slug: string, path = "/"): string {
  const env =
    typeof process !== "undefined" ? process.env : undefined;

  const base = env?.NEXT_PUBLIC_GATEWAY_BASE_URL;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (base) {
    return `${base.replace(/\/+$/, "")}/${slug}${normalizedPath}`;
  }

  const apiUrl = env?.NEXT_PUBLIC_API_URL;
  if (apiUrl && /localhost|127\.0\.0\.1/.test(apiUrl)) {
    return `${apiUrl.replace(/\/+$/, "")}/gw/${slug}${normalizedPath}`;
  }

  return `https://${slug}.${GATEWAY_DOMAIN}${normalizedPath}`;
}

export const TRIAL_DURATION_DAYS = 14;

export const MONTHLY_BASE_FEE_SATS = 4_000;

// 30-day rolling cycles. The previous 7-day cadence was too aggressive
// for a launch audience — owners got an invoice every week and only 72
// hours to pay. Stretching the cycle to 30 days and the grace window to
// 7 days reduces friction without changing per-request economics
// (monthly fee + tiers = exactly 4× the previous weekly equivalents).
export const BILLING_CYCLE_DAYS = 30;
export const GRACE_PERIOD_HOURS = 7 * 24; // 7 days
export const MAX_PAYMENT_RETRIES = 3;

export interface UsageTier {
  readonly upTo: number;
  readonly rate: number;
  /** Optional human label rendered on the pricing page. */
  readonly label?: string;
}

/**
 * Monthly usage tiers. Used both for billing computation (read by
 * `computeUsageFee` and the API's billing service) and for display on
 * the marketing pricing page.
 */
export const MONTHLY_USAGE_TIERS: readonly UsageTier[] = [
  { upTo: 400, rate: 0, label: "First 400 requests" },
  { upTo: 50_000, rate: 2, label: "401 – 50,000" },
  { upTo: 500_000, rate: 1, label: "50,001 – 500,000" },
  { upTo: Infinity, rate: 0.5, label: "500,001+" },
] as const;

export const FREE_REQUESTS_PER_MONTH = MONTHLY_USAGE_TIERS[0].upTo;

/**
 * Compute the usage fee for a given number of requests in a monthly
 * cycle. Tiered pricing — earlier requests are cheaper, free tier
 * applied first.
 */
export function computeUsageFee(requestCount: number): number {
  if (requestCount <= 0) return 0;

  let fee = 0;
  let processed = 0;

  for (const tier of MONTHLY_USAGE_TIERS) {
    const tierCapacity = tier.upTo - processed;
    const tierRequests = Math.min(requestCount - processed, tierCapacity);
    if (tierRequests <= 0) break;
    fee += tierRequests * tier.rate;
    processed += tierRequests;
  }

  return Math.ceil(fee);
}

/**
 * Compute the total monthly bill (base fee + usage fee).
 */
export function computeMonthlyBill(requestCount: number): number {
  return MONTHLY_BASE_FEE_SATS + computeUsageFee(requestCount);
}

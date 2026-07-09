import { z } from "zod";

export const tenantStatusEnum = z.enum(["onboarding", "active", "suspended", "deleted"]);
export const pricingModelEnum = z.enum(["per_request", "per_kb", "token_bucket", "time_pass", "metered"]);
export const invoiceStatusEnum = z.enum(["pending", "settled", "consumed", "expired", "cancelled"]);
export const billingCycleStatusEnum = z.enum(["accumulating", "invoiced", "paid", "failed"]);
export const billingStatusEnum = z.enum(["active", "trial", "grace_period", "suspended"]);
export const feeExemptReasonEnum = z.enum(["trial", "vip", "unused"]);
export const sessionStatusEnum = z.enum(["active", "expired", "depleted"]);

export const tenantSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  slug: z.string().min(3).max(63),
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  website: z.string().url().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  directoryListed: z.boolean().default(false),
  status: tenantStatusEnum,
  customDomain: z.string().nullable(),
  walletProvider: z.enum(["nwc", "lnd", "lnbits"]).nullable(),
  walletConnected: z.boolean(),
  walletConnectionMethod: z.enum(["one_click", "advanced", "node_launcher"]).nullable().optional(),
  walletAppName: z.string().nullable().optional(),
  walletAppUrl: z.string().url().nullable().optional(),
  autoPayEnabled: z.boolean(),
  emailWeeklySummary: z.boolean().default(false),
  billingStatus: billingStatusEnum,
  trialEndsAt: z.string().datetime().nullable(),
  maxConcurrentStreams: z.number().int().positive().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const endpointParameterSchema = z.object({
  name: z.string(),
  in: z.enum(["path", "query", "header", "body"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  type: z.string().optional(),
  default: z.unknown().optional(),
  example: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
});

export const originSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  baseUrl: z.string().url(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  healthNotificationsEnabled: z.boolean().default(true),
  createdAt: z.string().datetime(),
});

export const endpointSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  originId: z.string().uuid().nullable().optional(),
  path: z.string().min(1),
  originUrl: z.string().url().nullable().optional(),
  // Which hosted-platform mode the row is (DW tool model). Optional so rows read
  // from a cache written before the field existed still parse; defaults gateway.
  type: z.enum(["gateway", "sdk_tool"]).default("gateway"),
  method: z.string().default("GET"),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  docsUrl: z.string().url().nullable().optional(),
  exampleRequest: z.record(z.unknown()).nullable().optional(),
  exampleResponse: z.record(z.unknown()).nullable().optional(),
  parameters: z.array(endpointParameterSchema).nullable().optional(),
  isActive: z.boolean().default(true),
  directoryListed: z.boolean().default(true),
  cacheTtlSeconds: z.number().int().positive().nullable().optional(),
  rateLimitPerMinute: z.number().int().positive().nullable().optional(),
  freeTryEnabled: z.boolean().default(false),
  streaming: z.boolean().default(false),
  maxStreamSeconds: z.number().int().positive().nullable().optional(),
  idleTimeoutSeconds: z.number().int().positive().nullable().optional(),
  lastHealthCheckAt: z.string().datetime().nullable().optional(),
  isHealthy: z.boolean().default(true),
  uptimePercentage: z.string().nullable().optional(),
  avgResponseTimeMs: z.number().int().nullable().optional(),
  healthNotificationsEnabled: z.boolean().default(true),
  createdAt: z.string().datetime(),
});

export const pricingRuleSchema = z.object({
  id: z.string().uuid(),
  endpointId: z.string().uuid(),
  pricingModel: pricingModelEnum,
  priceSats: z.number().int().positive(),
  tokenBudget: z.number().int().positive().nullable(),
  durationMinutes: z.number().int().positive().nullable(),
  unitCostSats: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
});

export const invoiceSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  endpointId: z.string().uuid(),
  paymentHash: z.string(),
  paymentRequest: z.string(),
  amountSats: z.number().int().positive(),
  platformFeeSats: z.number().int().nonnegative(),
  status: invoiceStatusEnum,
  expiresAt: z.string().datetime().nullable(),
  settledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const billingCycleSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime().nullable(),
  requestCount: z.number().int().nonnegative(),
  baseFeeSats: z.number().int().nonnegative(),
  usageFeeSats: z.number().int().nonnegative(),
  totalDueSats: z.number().int().nonnegative(),
  feeExemptReason: feeExemptReasonEnum.nullable(),
  waivedFeeSats: z.number().int().nonnegative(),
  status: billingCycleStatusEnum,
  paymentHash: z.string().nullable(),
  paymentRequest: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  paidAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const sessionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  endpointId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  tokenHash: z.string(),
  pricingModel: pricingModelEnum,
  expiresAt: z.string().datetime().nullable(),
  balanceSats: z.number().int().nullable(),
  remainingTokens: z.number().int().nullable().optional(),
  totalUsedSats: z.number().int().nonnegative(),
  status: sessionStatusEnum,
  createdAt: z.string().datetime(),
});

export const createTenantSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(3).max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: "Slug must be lowercase alphanumeric with hyphens, cannot start/end with hyphen",
  }),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  directoryListed: z.boolean().optional(),
  walletProvider: z.enum(["nwc", "lnd", "lnbits"]).optional(),
  walletConfig: z.record(z.string()).optional(),
});

export const createOriginSchema = z.object({
  baseUrl: z.string().url(),
  name: z.string().max(255).optional(),
  description: z.string().max(1000).optional(),
});

export const createEndpointSchema = z
  .object({
    // For gateway endpoints this is the HTTP route (must start with `/`); for
    // sdk_tool endpoints it is the MCP resource name (no leading slash). The
    // per-type rule is enforced in the superRefine below.
    path: z.string().min(1),
    originUrl: z.string().url().optional(),
    originId: z.string().uuid().optional(),
    // Which hosted-platform mode this row is. `gateway` (default) = an HTTP
    // route proxied via an origin. `sdk_tool` = a tool the seller serves
    // themselves, priced here and settled via the hosted facilitator.
    type: z.enum(["gateway", "sdk_tool"]).default("gateway"),
    // Listable methods are restricted to data (GET/HEAD) and computation (POST).
    // Mutating verbs (PUT/PATCH/DELETE) don't fit anonymous pay-per-call — they
    // mutate caller-owned state, which needs an identity L402 doesn't provide.
    method: z.enum(["GET", "POST", "HEAD"]).default("GET"),
    title: z.string().max(255).optional(),
    description: z.string().max(1000).optional(),
    docsUrl: z.string().url().max(1000).optional(),
    exampleRequest: z.record(z.unknown()).optional(),
    exampleResponse: z.record(z.unknown()).optional(),
    parameters: z.array(endpointParameterSchema).optional(),
    cacheTtlSeconds: z.number().int().positive().optional(),
    rateLimitPerMinute: z.number().int().positive().optional(),
    freeTryEnabled: z.boolean().optional(),
    liveSampleEnabled: z.boolean().optional(),
    streaming: z.boolean().optional(),
    maxStreamSeconds: z.number().int().positive().optional(),
    idleTimeoutSeconds: z.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === "sdk_tool") {
      // sdk_tool is served from the seller's own server — no origin, no proxy.
      if (val.originId || val.originUrl) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["originId"], message: "An SDK tool has no origin — it is served from your own server" });
      }
    } else if (!val.path.startsWith("/")) {
      // gateway path rule, preserved from the original schema.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "Path must start with /" });
    }
  });

export const createPricingRuleSchema = z.object({
  pricingModel: pricingModelEnum,
  priceSats: z.number().int().positive(),
  tokenBudget: z.number().int().positive().optional(),
  durationMinutes: z.number().int().positive().optional(),
  unitCostSats: z.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  if (data.pricingModel === "metered" && !data.unitCostSats) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unitCostSats is required for metered pricing", path: ["unitCostSats"] });
  }
  if (data.pricingModel === "per_kb" && !data.unitCostSats) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unitCostSats is required for per_kb pricing", path: ["unitCostSats"] });
  }
  if (data.pricingModel === "token_bucket" && !data.tokenBudget) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tokenBudget is required for token_bucket pricing", path: ["tokenBudget"] });
  }
  if (data.pricingModel === "time_pass" && !data.durationMinutes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "durationMinutes is required for time_pass pricing", path: ["durationMinutes"] });
  }
});

export const directoryTesterMethodEnum = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
]);

export const directoryTesterInitSchema = z.object({
  slug: z.string().min(1).max(128),
  path: z.string().min(1).max(1024),
  method: directoryTesterMethodEnum,
  queryParams: z.string().max(5000).optional(),
  requestBody: z.string().max(1_048_576).optional(),
});

export const directoryTesterResultSchema = z.object({
  kind: z.literal("result"),
  status: z.number().int(),
  contentType: z.string(),
  body: z.unknown(),
});

export const directoryTesterPaymentRequiredSchema = z.object({
  kind: z.literal("payment_required"),
  attemptId: z.string().uuid(),
  paymentHash: z.string(),
  invoice: z.string(),
  amountSats: z.number().int().positive().nullable(),
  expiresAt: z.string().datetime(),
});

export const directoryTesterStatusSchema = z.object({
  attemptId: z.string().uuid(),
  paymentHash: z.string(),
  status: invoiceStatusEnum,
  settledAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
});

export const userNwcProfileSchema = z.object({
  connected: z.boolean(),
  connectionUriHint: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
  lastUsedAt: z.string().datetime().nullable().optional(),
});

// ── Auth form schemas ────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const signupSchema = z
  .object({
    email: z.string().email("Please enter a valid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const forgotPasswordSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
});

export const resetPasswordSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

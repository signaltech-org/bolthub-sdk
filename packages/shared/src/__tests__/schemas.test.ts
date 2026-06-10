import { describe, test, expect } from "bun:test";
import {
  pricingModelEnum,
  sessionStatusEnum,
  billingCycleStatusEnum,
  billingStatusEnum,
  createPricingRuleSchema,
  pricingRuleSchema,
  sessionSchema,
  tenantSchema,
  billingCycleSchema,
} from "../schemas";

describe("pricingModelEnum", () => {
  test("accepts all valid models", () => {
    for (const model of ["per_request", "per_kb", "token_bucket", "time_pass", "metered"]) {
      expect(pricingModelEnum.parse(model)).toBe(model);
    }
  });

  test("rejects invalid model", () => {
    expect(() => pricingModelEnum.parse("invalid")).toThrow();
  });
});

describe("sessionStatusEnum", () => {
  test("accepts all valid statuses", () => {
    for (const status of ["active", "expired", "depleted"]) {
      expect(sessionStatusEnum.parse(status)).toBe(status);
    }
  });
});

describe("billingCycleStatusEnum", () => {
  test("accepts all valid statuses", () => {
    for (const status of ["accumulating", "invoiced", "paid", "failed"]) {
      expect(billingCycleStatusEnum.parse(status)).toBe(status);
    }
  });

  test("rejects invalid status", () => {
    expect(() => billingCycleStatusEnum.parse("pending")).toThrow();
  });
});

describe("billingStatusEnum", () => {
  test("accepts all valid statuses", () => {
    for (const status of ["active", "trial", "grace_period", "suspended"]) {
      expect(billingStatusEnum.parse(status)).toBe(status);
    }
  });

  test("rejects invalid status", () => {
    expect(() => billingStatusEnum.parse("cancelled")).toThrow();
  });
});

describe("createPricingRuleSchema", () => {
  test("validates per_request rule", () => {
    const result = createPricingRuleSchema.safeParse({
      pricingModel: "per_request",
      priceSats: 100,
    });
    expect(result.success).toBe(true);
  });

  test("validates time_pass rule with durationMinutes", () => {
    const result = createPricingRuleSchema.safeParse({
      pricingModel: "time_pass",
      priceSats: 500,
      durationMinutes: 60,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durationMinutes).toBe(60);
    }
  });

  test("validates metered rule with unitCostSats", () => {
    const result = createPricingRuleSchema.safeParse({
      pricingModel: "metered",
      priceSats: 1000,
      unitCostSats: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unitCostSats).toBe(5);
    }
  });

  test("rejects zero priceSats", () => {
    const result = createPricingRuleSchema.safeParse({
      pricingModel: "per_request",
      priceSats: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative priceSats", () => {
    const result = createPricingRuleSchema.safeParse({
      pricingModel: "per_request",
      priceSats: -10,
    });
    expect(result.success).toBe(false);
  });
});

describe("pricingRuleSchema", () => {
  test("validates full pricing rule", () => {
    const result = pricingRuleSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      endpointId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      pricingModel: "time_pass",
      priceSats: 500,
      tokenBudget: null,
      durationMinutes: 60,
      unitCostSats: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("validates metered pricing rule", () => {
    const result = pricingRuleSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      endpointId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      pricingModel: "metered",
      priceSats: 1000,
      tokenBudget: null,
      durationMinutes: null,
      unitCostSats: 5,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("tenantSchema", () => {
  test("validates a tenant with billing fields", () => {
    const result = tenantSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      userId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      slug: "my-api",
      name: "My API",
      status: "active",
      customDomain: null,
      walletProvider: "nwc",
      walletConnected: true,
      autoPayEnabled: true,
      emailWeeklySummary: true,
      billingStatus: "active",
      trialEndsAt: "2025-01-15T00:00:00.000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("validates a tenant in trial", () => {
    const result = tenantSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      userId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      slug: "my-api",
      name: "My API",
      status: "onboarding",
      customDomain: null,
      walletProvider: null,
      walletConnected: false,
      autoPayEnabled: false,
      emailWeeklySummary: false,
      billingStatus: "trial",
      trialEndsAt: "2025-01-15T00:00:00.000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = tenantSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      userId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      slug: "my-api",
      name: "My API",
      status: "invalid",
      customDomain: null,
      walletProvider: null,
      walletConnected: false,
      autoPayEnabled: false,
      emailWeeklySummary: false,
      billingStatus: "trial",
      trialEndsAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("billingCycleSchema", () => {
  test("validates an accumulating cycle", () => {
    const result = billingCycleSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      tenantId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: null,
      requestCount: 150,
      baseFeeSats: 0,
      usageFeeSats: 0,
      totalDueSats: 0,
      feeExemptReason: null,
      waivedFeeSats: 0,
      status: "accumulating",
      paymentHash: null,
      paymentRequest: null,
      retryCount: 0,
      paidAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("validates a paid cycle", () => {
    const result = billingCycleSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      tenantId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: "2025-01-08T00:00:00.000Z",
      requestCount: 5000,
      baseFeeSats: 750,
      usageFeeSats: 9500,
      totalDueSats: 10250,
      feeExemptReason: null,
      waivedFeeSats: 0,
      status: "paid",
      paymentHash: "abc123",
      paymentRequest: "lnbc...",
      retryCount: 0,
      paidAt: "2025-01-08T01:00:00.000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = billingCycleSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      tenantId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: null,
      requestCount: 0,
      baseFeeSats: 0,
      usageFeeSats: 0,
      totalDueSats: 0,
      status: "active",
      paymentHash: null,
      paymentRequest: null,
      retryCount: 0,
      paidAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("sessionSchema", () => {
  test("validates a time_pass session", () => {
    const result = sessionSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      tenantId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      endpointId: "f47ac10b-58cc-4372-a567-0e02b2c3d481",
      invoiceId: "f47ac10b-58cc-4372-a567-0e02b2c3d482",
      tokenHash: "abcdef1234567890",
      pricingModel: "time_pass",
      expiresAt: "2025-12-01T00:00:00.000Z",
      balanceSats: null,
      totalUsedSats: 0,
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("validates a metered session", () => {
    const result = sessionSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      tenantId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      endpointId: "f47ac10b-58cc-4372-a567-0e02b2c3d481",
      invoiceId: "f47ac10b-58cc-4372-a567-0e02b2c3d482",
      tokenHash: "abcdef1234567890",
      pricingModel: "metered",
      expiresAt: null,
      balanceSats: 950,
      totalUsedSats: 50,
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid session status", () => {
    const result = sessionSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      tenantId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      endpointId: "f47ac10b-58cc-4372-a567-0e02b2c3d481",
      invoiceId: "f47ac10b-58cc-4372-a567-0e02b2c3d482",
      tokenHash: "abcdef1234567890",
      pricingModel: "metered",
      expiresAt: null,
      balanceSats: 950,
      totalUsedSats: 50,
      status: "invalid_status",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

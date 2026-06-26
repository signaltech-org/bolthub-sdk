import { describe, test, expect } from "bun:test";
import {
  MONTHLY_BASE_FEE_SATS,
  FREE_REQUESTS_PER_MONTH,
  MONTHLY_USAGE_TIERS,
  TRIAL_DURATION_DAYS,
  TRIAL_DURATION_LABEL,
  BILLING_CYCLE_DAYS,
  GRACE_PERIOD_HOURS,
  MAX_PAYMENT_RETRIES,
  computeUsageFee,
  computeMonthlyBill,
} from "../constants";

describe("pricing constants", () => {
  test("monthly base fee is 4000 sats", () => {
    expect(MONTHLY_BASE_FEE_SATS).toBe(4_000);
  });

  test("free requests per month is 400", () => {
    expect(FREE_REQUESTS_PER_MONTH).toBe(400);
  });

  test("trial is 30 days (1 month)", () => {
    expect(TRIAL_DURATION_DAYS).toBe(30);
  });

  test("trial copy label matches the trial duration", () => {
    expect(TRIAL_DURATION_LABEL).toBe("1-month");
  });

  test("billing cycle is 30 days", () => {
    expect(BILLING_CYCLE_DAYS).toBe(30);
  });

  test("grace period is 7 days (168 hours)", () => {
    expect(GRACE_PERIOD_HOURS).toBe(168);
  });

  test("max payment retries is 3", () => {
    expect(MAX_PAYMENT_RETRIES).toBe(3);
  });
});

describe("MONTHLY_USAGE_TIERS", () => {
  test("has 4 tiers", () => {
    expect(MONTHLY_USAGE_TIERS).toHaveLength(4);
  });

  test("first 400 requests are free", () => {
    expect(MONTHLY_USAGE_TIERS[0].upTo).toBe(400);
    expect(MONTHLY_USAGE_TIERS[0].rate).toBe(0);
  });

  test("second tier is 2 sats/req (up to 50,000)", () => {
    expect(MONTHLY_USAGE_TIERS[1].upTo).toBe(50_000);
    expect(MONTHLY_USAGE_TIERS[1].rate).toBe(2);
  });

  test("third tier is 1 sat/req (up to 500,000)", () => {
    expect(MONTHLY_USAGE_TIERS[2].upTo).toBe(500_000);
    expect(MONTHLY_USAGE_TIERS[2].rate).toBe(1);
  });

  test("fourth tier is 0.5 sats/req (unlimited)", () => {
    expect(MONTHLY_USAGE_TIERS[3].upTo).toBe(Infinity);
    expect(MONTHLY_USAGE_TIERS[3].rate).toBe(0.5);
  });

  test("rates decrease as volume increases", () => {
    for (let i = 1; i < MONTHLY_USAGE_TIERS.length; i++) {
      expect(MONTHLY_USAGE_TIERS[i].rate)
        .toBeLessThanOrEqual(MONTHLY_USAGE_TIERS[i - 1].rate || Infinity);
    }
  });
});

describe("computeUsageFee", () => {
  test("returns 0 for zero requests", () => {
    expect(computeUsageFee(0)).toBe(0);
  });

  test("returns 0 for negative requests", () => {
    expect(computeUsageFee(-5)).toBe(0);
  });

  test("returns 0 for requests within free tier", () => {
    expect(computeUsageFee(200)).toBe(0);
    expect(computeUsageFee(400)).toBe(0);
  });

  test("charges 2 sats/req for tier 2 (401–50,000)", () => {
    expect(computeUsageFee(401)).toBe(2);
    expect(computeUsageFee(500)).toBe(200);
    expect(computeUsageFee(1400)).toBe(2000);
  });

  test("charges 1 sat/req for tier 3 (50,001–500,000)", () => {
    // 400 free + 49,600 at 2 sats = 99,200 + 1 at 1 sat = 99,201
    expect(computeUsageFee(50_001)).toBe(99_201);
  });

  test("charges 0.5 sats/req for tier 4 (>500,000, rounds up)", () => {
    // 400 free + 49,600 at 2 = 99,200 + 450,000 at 1 = 549,200
    // + 1 at 0.5 = 549,201 (rounds up)
    expect(computeUsageFee(500_001)).toBe(549_201);
  });

  test("handles large request volumes", () => {
    // 400 free + 49,600 * 2 = 99,200 + 450,000 * 1 = 549,200 + 300,000 * 0.5 = 699,200
    expect(computeUsageFee(800_000)).toBe(699_200);
  });
});

describe("computeMonthlyBill", () => {
  test("returns base fee for zero requests", () => {
    expect(computeMonthlyBill(0)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("returns base fee for requests in free tier", () => {
    expect(computeMonthlyBill(200)).toBe(MONTHLY_BASE_FEE_SATS);
    expect(computeMonthlyBill(400)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("adds usage fee to base fee", () => {
    // 400 free + 100 at 2 sats = 200
    expect(computeMonthlyBill(500)).toBe(MONTHLY_BASE_FEE_SATS + 200);
  });
});

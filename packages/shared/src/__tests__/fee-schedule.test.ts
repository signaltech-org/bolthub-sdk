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
  USAGE_FEE_EARNINGS_CAP_BPS,
  computeUsageFee,
  computeCappedUsageFee,
  computeMonthlyBill,
} from "../constants";

describe("pricing constants", () => {
  test("monthly base fee is 5000 sats", () => {
    expect(MONTHLY_BASE_FEE_SATS).toBe(5_000);
  });

  test("free requests per month is 500", () => {
    expect(FREE_REQUESTS_PER_MONTH).toBe(500);
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

  test("first 500 requests are free", () => {
    expect(MONTHLY_USAGE_TIERS[0].upTo).toBe(500);
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
    expect(computeUsageFee(500)).toBe(0);
  });

  test("charges 2 sats/req for tier 2 (501–50,000)", () => {
    expect(computeUsageFee(501)).toBe(2);
    expect(computeUsageFee(600)).toBe(200);
    expect(computeUsageFee(1500)).toBe(2000);
  });

  test("charges 1 sat/req for tier 3 (50,001–500,000)", () => {
    // 500 free + 49,500 at 2 sats = 99,000 + 1 at 1 sat = 99,001
    expect(computeUsageFee(50_001)).toBe(99_001);
  });

  test("charges 0.5 sats/req for tier 4 (>500,000, rounds up)", () => {
    // 500 free + 49,500 at 2 = 99,000 + 450,000 at 1 = 549,000
    // + 1 at 0.5 = 549,001 (rounds up)
    expect(computeUsageFee(500_001)).toBe(549_001);
  });

  test("handles large request volumes", () => {
    // 500 free + 49,500 * 2 = 99,000 + 450,000 * 1 = 549,000 + 300,000 * 0.5 = 699,000
    expect(computeUsageFee(800_000)).toBe(699_000);
  });
});

describe("computeMonthlyBill", () => {
  test("returns base fee for zero requests", () => {
    expect(computeMonthlyBill(0)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("returns base fee for requests in free tier", () => {
    expect(computeMonthlyBill(200)).toBe(MONTHLY_BASE_FEE_SATS);
    expect(computeMonthlyBill(500)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("adds usage fee to base fee", () => {
    // 500 free + 100 at 2 sats = 200
    expect(computeMonthlyBill(600)).toBe(MONTHLY_BASE_FEE_SATS + 200);
  });

  test("applies the earnings cap when settledSats is provided", () => {
    // Tier fee for 100k requests is 149,000; 5% of 100k earned is 5,000.
    expect(computeMonthlyBill(100_000, 100_000)).toBe(MONTHLY_BASE_FEE_SATS + 5_000);
  });

  test("without settledSats returns the uncapped worst case", () => {
    expect(computeMonthlyBill(100_000)).toBe(MONTHLY_BASE_FEE_SATS + 149_000);
  });
});

describe("usage-fee earnings cap", () => {
  test("cap is 500 bps (5%)", () => {
    expect(USAGE_FEE_EARNINGS_CAP_BPS).toBe(500);
  });

  test("cap only ever lowers the fee, never raises it", () => {
    // Earnings so high the cap is far above the tier fee: schedule applies.
    expect(computeCappedUsageFee(600, 10_000_000)).toBe(computeUsageFee(600));
    expect(computeCappedUsageFee(100_000, 100_000_000)).toBe(computeUsageFee(100_000));
  });

  test("caps the micro-priced seller at 5% of earnings", () => {
    // 100k requests at 1 sat/call earned 100k sats. Tier fee would be
    // 149,000 (more than they earned); capped to 5,000.
    expect(computeUsageFee(100_000)).toBe(149_000);
    expect(computeCappedUsageFee(100_000, 100_000)).toBe(5_000);
  });

  test("zero earnings cap the usage fee at zero", () => {
    expect(computeCappedUsageFee(100_000, 0)).toBe(0);
  });

  test("negative earnings are treated as zero", () => {
    expect(computeCappedUsageFee(100_000, -50)).toBe(0);
  });

  test("cap floors fractional sats in the tenant's favor", () => {
    // 5% of 99 sats is 4.95 → 4 sats.
    expect(computeCappedUsageFee(100_000, 99)).toBe(4);
  });

  test("free-tier cycles owe nothing regardless of earnings", () => {
    expect(computeCappedUsageFee(500, 1_000_000)).toBe(0);
  });
});

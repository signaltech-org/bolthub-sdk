import { describe, test, expect } from "bun:test";
import {
  computeUsageFee,
  computeMonthlyBill,
  MONTHLY_BASE_FEE_SATS,
} from "../constants";

// Focused regression suite for the monthly-cycle math. The broader
// tier coverage lives in `fee-schedule.test.ts`; this file pins
// the per-cycle boundaries that matter for invoice arithmetic.

describe("computeUsageFee monthly boundaries", () => {
  test("500 requests → 0 (exactly at free tier boundary)", () => {
    expect(computeUsageFee(500)).toBe(0);
  });

  test("501 requests → 2 sats (1 request in tier 2 at 2 sats/req)", () => {
    expect(computeUsageFee(501)).toBe(2);
  });

  test("50,000 requests → 99,000 sats (500 free + 49,500 × 2)", () => {
    expect(computeUsageFee(50_000)).toBe(99_000);
  });

  test("50,001 requests → 99,001 sats (1 in tier 3 at 1 sat/req)", () => {
    expect(computeUsageFee(50_001)).toBe(99_001);
  });

  test("500,000 requests → 549,000 sats", () => {
    // 500 free + 49,500 × 2 + 450,000 × 1 = 0 + 99,000 + 450,000 = 549,000
    expect(computeUsageFee(500_000)).toBe(549_000);
  });

  test("800,000 requests → 699,000 sats (includes tier 4 at 0.5 sats/req)", () => {
    // 500 free + 49,500 × 2 + 450,000 × 1 + 300,000 × 0.5
    // = 0 + 99,000 + 450,000 + 150,000 = 699,000
    expect(computeUsageFee(800_000)).toBe(699_000);
  });

  test("negative requests → 0", () => {
    expect(computeUsageFee(-1)).toBe(0);
    expect(computeUsageFee(-1000)).toBe(0);
  });
});

describe("computeMonthlyBill", () => {
  test("adds MONTHLY_BASE_FEE_SATS (5000) to the usage fee", () => {
    expect(MONTHLY_BASE_FEE_SATS).toBe(5_000);
  });

  test("0 requests → base fee only", () => {
    expect(computeMonthlyBill(0)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("500 requests → base fee only (free tier)", () => {
    expect(computeMonthlyBill(500)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("4000 requests → 5000 + 7000 = 12000", () => {
    // 500 free + 3500 × 2 = 7000 usage
    expect(computeMonthlyBill(4000)).toBe(MONTHLY_BASE_FEE_SATS + 7_000);
  });

  test("negative requests → base fee only", () => {
    expect(computeMonthlyBill(-5)).toBe(MONTHLY_BASE_FEE_SATS);
  });
});

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
  test("400 requests → 0 (exactly at free tier boundary)", () => {
    expect(computeUsageFee(400)).toBe(0);
  });

  test("401 requests → 2 sats (1 request in tier 2 at 2 sats/req)", () => {
    expect(computeUsageFee(401)).toBe(2);
  });

  test("50,000 requests → 99,200 sats (400 free + 49,600 × 2)", () => {
    expect(computeUsageFee(50_000)).toBe(99_200);
  });

  test("50,001 requests → 99,201 sats (1 in tier 3 at 1 sat/req)", () => {
    expect(computeUsageFee(50_001)).toBe(99_201);
  });

  test("500,000 requests → 549,200 sats", () => {
    // 400 free + 49,600 × 2 + 450,000 × 1 = 0 + 99,200 + 450,000 = 549,200
    expect(computeUsageFee(500_000)).toBe(549_200);
  });

  test("800,000 requests → 699,200 sats (includes tier 4 at 0.5 sats/req)", () => {
    // 400 free + 49,600 × 2 + 450,000 × 1 + 300,000 × 0.5
    // = 0 + 99,200 + 450,000 + 150,000 = 699,200
    expect(computeUsageFee(800_000)).toBe(699_200);
  });

  test("negative requests → 0", () => {
    expect(computeUsageFee(-1)).toBe(0);
    expect(computeUsageFee(-1000)).toBe(0);
  });
});

describe("computeMonthlyBill", () => {
  test("adds MONTHLY_BASE_FEE_SATS (4000) to the usage fee", () => {
    expect(MONTHLY_BASE_FEE_SATS).toBe(4_000);
  });

  test("0 requests → base fee only", () => {
    expect(computeMonthlyBill(0)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("400 requests → base fee only (free tier)", () => {
    expect(computeMonthlyBill(400)).toBe(MONTHLY_BASE_FEE_SATS);
  });

  test("4000 requests → 4000 + 7200 = 11200", () => {
    // 400 free + 3600 × 2 = 7200 usage
    expect(computeMonthlyBill(4000)).toBe(MONTHLY_BASE_FEE_SATS + 7_200);
  });

  test("negative requests → base fee only", () => {
    expect(computeMonthlyBill(-5)).toBe(MONTHLY_BASE_FEE_SATS);
  });
});

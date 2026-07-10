import { describe, expect, test } from "bun:test";
import { Budget } from "../budget";
import { PaymentBudgetError } from "../errors";
import { ToolClient } from "../buyer/client";
import { L402Client, L402BudgetError } from "../http/client";
import type { PaymentPayer } from "../types";
import type { WalletAdapter } from "../http/types";

describe("Budget", () => {
  test("tracks per-asset spend independently", () => {
    const b = new Budget({ maxTotal: { sat: 100, usd: 5 } });
    b.reserve("sat", 60);
    b.reserve("usd", 2);
    expect(b.spentFor("sat")).toBe(60);
    expect(b.spentFor("usd")).toBe(2);
    expect(b.remainingFor("sat")).toBe(40);
    expect(b.remainingFor("usd")).toBe(3);
  });

  test("unset asset is unlimited", () => {
    const b = new Budget({ maxTotal: { sat: 10 } });
    expect(b.remainingFor("usd")).toBe(Infinity);
    b.reserve("usd", 1_000_000);
    expect(b.spentFor("usd")).toBe(1_000_000);
  });

  test("reserve throws PaymentBudgetError past maxTotal", () => {
    const b = new Budget({ maxTotal: { sat: 100 } });
    b.reserve("sat", 100);
    expect(() => b.reserve("sat", 1)).toThrow(PaymentBudgetError);
    expect(b.spentFor("sat")).toBe(100); // failed reserve counts nothing
  });

  test("maxPerCall caps a single reservation", () => {
    const b = new Budget({ maxPerCall: { sat: 50 } });
    expect(() => b.reserve("sat", 51)).toThrow(/per-call cap/);
    b.reserve("sat", 50);
    expect(b.spentFor("sat")).toBe(50);
  });

  test("perCallOverride tightens but never loosens the per-call cap", () => {
    const b = new Budget({ maxPerCall: { sat: 50 } });
    expect(() => b.reserve("sat", 30, 20)).toThrow(/per-call cap/);
    // an override above maxPerCall must not loosen it
    expect(() => b.reserve("sat", 60, 100)).toThrow(/per-call cap/);
    b.reserve("sat", 20, 20);
    expect(b.spentFor("sat")).toBe(20);
  });

  test("rollback restores headroom", () => {
    const b = new Budget({ maxTotal: { sat: 100 } });
    b.reserve("sat", 100);
    b.rollback("sat", 100);
    expect(b.spentFor("sat")).toBe(0);
    b.reserve("sat", 100); // fits again
  });

  test("check rejects zero, negative, and non-finite amounts", () => {
    const b = new Budget();
    expect(b.check("sat", 0)).toBe("invalid offer amount");
    expect(b.check("sat", -5)).toBe("invalid offer amount");
    expect(b.check("sat", NaN)).toBe("invalid offer amount");
    expect(b.check("sat", 1)).toBeUndefined();
  });

  test("synchronous reserve: sequential reserves cannot jointly overspend", () => {
    const b = new Budget({ maxTotal: { sat: 100 } });
    b.reserve("sat", 60);
    expect(() => b.reserve("sat", 60)).toThrow(PaymentBudgetError);
  });

  test("reserveTotal ignores the per-call cap but honors the total (delegation)", () => {
    const b = new Budget({ maxTotal: { sat: 1000 }, maxPerCall: { sat: 100 } });
    // A 300-sat delegated cap exceeds the 100 per-call ceiling but fits the total.
    b.reserveTotal("sat", 300);
    expect(b.spentFor("sat")).toBe(300);
    b.reserveTotal("sat", 700); // now exactly at 1000
    expect(b.remainingFor("sat")).toBe(0);
    // Boundary: == remaining accepted (above), remaining + 1 refused.
    expect(() => b.reserveTotal("sat", 1)).toThrow(PaymentBudgetError);
    expect(b.spentFor("sat")).toBe(1000); // failed reserve counts nothing
  });

  test("reserveTotal rejects non-positive amounts", () => {
    const b = new Budget({ maxTotal: { sat: 100 } });
    expect(() => b.reserveTotal("sat", 0)).toThrow(PaymentBudgetError);
    expect(() => b.reserveTotal("sat", -5)).toThrow(PaymentBudgetError);
  });
});

describe("L402Client delegated-cap interlock (AF-D6)", () => {
  const wallet: WalletAdapter = { payInvoice: async () => ({ preimage: "beef" }) };

  test("reserves against an external shared Budget: == remaining accepted, +1 refused", () => {
    const budget = new Budget({ maxTotal: { sat: 1000 } });
    const client = new L402Client({ wallet, budget });
    client.reserveDelegatedCap(1000); // exactly the remaining budget
    expect(client.remainingBudget).toBe(0);
    expect(() => client.reserveDelegatedCap(1)).toThrow(L402BudgetError);
  });

  test("reserves against internal budgetSats and rolls back", () => {
    const client = new L402Client({ wallet, budgetSats: 500 });
    client.reserveDelegatedCap(300);
    expect(client.remainingBudget).toBe(200);
    expect(() => client.reserveDelegatedCap(201)).toThrow(L402BudgetError);
    client.rollbackDelegatedCap(300);
    expect(client.remainingBudget).toBe(500);
  });

  test("no budget configured → reserve is a no-op (unlimited)", () => {
    const client = new L402Client({ wallet });
    expect(() => client.reserveDelegatedCap(1_000_000)).not.toThrow();
    expect(client.remainingBudget).toBe(Infinity);
  });

  test("rejects a non-positive cap", () => {
    const client = new L402Client({ wallet, budgetSats: 500 });
    expect(() => client.reserveDelegatedCap(0)).toThrow();
    expect(() => client.reserveDelegatedCap(-5)).toThrow();
  });
});

describe("shared Budget across ToolClient and L402Client", () => {
  const paidWallet: WalletAdapter = {
    payInvoice: async () => ({ preimage: "00".repeat(32) }),
  };

  const noopPayer: PaymentPayer = {
    scheme: "l402",
    pay: async (offer) => ({
      proof: "tok:pre",
      amount: Number(offer.amount),
      asset: String(offer.asset),
    }),
  };

  test("ToolClient with external budget reads and writes the shared pool", () => {
    const budget = new Budget({ maxTotal: { sat: 100 } });
    const tool = new ToolClient({ payers: [noopPayer], budget });
    budget.reserve("sat", 80); // spend arrives from elsewhere (e.g. an L402Client)
    expect(tool.spentFor("sat")).toBe(80);
    expect(tool.remainingFor("sat")).toBe(20);
  });

  test("ToolClient rejects budget alongside maxTotal/maxPerCall", () => {
    const budget = new Budget();
    expect(
      () => new ToolClient({ payers: [noopPayer], budget, maxTotal: { sat: 1 } }),
    ).toThrow(/not both/);
  });

  test("L402Client rejects budget alongside budgetSats", () => {
    const budget = new Budget();
    expect(
      () => new L402Client({ wallet: paidWallet, budget, budgetSats: 10 }),
    ).toThrow(/not both/);
  });

  test("L402Client draws from the shared pool and reports it", async () => {
    const budget = new Budget({ maxTotal: { sat: 100 } });
    const paid: Array<{ amount: number; asset: string }> = [];
    const client = new L402Client({
      wallet: paidWallet,
      budget,
      onPaid: (info) => paid.push({ amount: info.amount, asset: info.asset }),
    });

    // 402 with a priced challenge, then 200 after payment.
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ amountSats: 40 }), {
          status: 402,
          headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc1"' },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const resp = await client.request("https://example.gw.bolthub.ai/v1/data");
      expect(resp.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(budget.spentFor("sat")).toBe(40);
    expect(client.totalSpent).toBe(40);
    expect(paid).toEqual([{ amount: 40, asset: "sat" }]);
  });

  test("spend on one path refuses the other past maxTotal", async () => {
    const budget = new Budget({ maxTotal: { sat: 50 } });
    budget.reserve("sat", 30); // as if a ToolClient payment landed first

    const client = new L402Client({ wallet: paidWallet, budget });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ amountSats: 40 }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc1"' },
      })) as typeof fetch;

    try {
      await expect(client.request("https://example.gw.bolthub.ai/v1/data")).rejects.toThrow(
        L402BudgetError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(budget.spentFor("sat")).toBe(30); // nothing reserved by the refused call
  });

  test("wallet failure rolls the shared reservation back", async () => {
    const budget = new Budget({ maxTotal: { sat: 100 } });
    const failingWallet: WalletAdapter = {
      payInvoice: async () => {
        throw new Error("no route");
      },
    };
    const client = new L402Client({ wallet: failingWallet, budget, payRetries: 0 });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ amountSats: 40 }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc1"' },
      })) as typeof fetch;

    try {
      await expect(client.request("https://example.gw.bolthub.ai/v1/data")).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(budget.spentFor("sat")).toBe(0); // rolled back — headroom restored
  });

  test("budget maxPerCall caps L402 requests when maxPerRequestSats is unset", async () => {
    const budget = new Budget({ maxPerCall: { sat: 10 } });
    const client = new L402Client({ wallet: paidWallet, budget });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ amountSats: 25 }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc1"' },
      })) as typeof fetch;

    try {
      await expect(client.request("https://example.gw.bolthub.ai/v1/data")).rejects.toThrow(
        /per-request limit/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("per-request maxCostSats tightens the cap for one call only", async () => {
    const budget = new Budget({ maxTotal: { sat: 1000 } });
    const client = new L402Client({ wallet: paidWallet, budget });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ amountSats: 25 }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc1"' },
      })) as typeof fetch;

    try {
      await expect(
        client.request("https://example.gw.bolthub.ai/v1/data", { maxCostSats: 10 }),
      ).rejects.toThrow(/per-request limit/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(budget.spentFor("sat")).toBe(0);
  });
});

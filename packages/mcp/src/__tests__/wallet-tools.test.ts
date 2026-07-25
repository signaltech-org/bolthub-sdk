/**
 * WalletSource / wallet_status — the payer-side diagnostic added for
 * 2026-07-25 smoke finding F11 (no way to inspect the SPENDING wallet).
 */

import { describe, test, expect } from "bun:test";
import { WalletSource, paymentFailureHint } from "../sources/wallet-tools";
import type { L402Client, WalletAdapter } from "@bolthub/pay";

const fakeL402 = (spent = 208, remaining = 49_792) =>
  ({ totalSpent: spent, remainingBudget: remaining }) as L402Client;

describe("wallet_status", () => {
  test("renders balance, permissions, and the session budget", async () => {
    const wallet: WalletAdapter = {
      payInvoice: async () => ({ preimage: "x" }),
      diagnose: async () => ({
        kind: "nwc",
        balanceSats: 1353,
        alias: "Spender",
        network: "mainnet",
        pubkey: "03abc",
        methods: ["pay_invoice", "get_balance", "get_info"],
        canPayInvoices: true,
      }),
    };
    const source = new WalletSource(wallet, fakeL402());
    const result = await source.callTool("wallet_status");
    const text = result.content[0].text;

    expect(result.isError).toBeUndefined();
    expect(text).toContain("Spending wallet: nwc");
    expect(text).toContain("Balance: 1353 sats");
    expect(text).toContain("Can pay invoices: yes");
    expect(text).toContain("Session spending: 208 sats | Remaining budget: 49792 sats");
    expect(text).not.toContain("WARNING");
  });

  test("a receive-only connection gets the loud pay_invoice warning", async () => {
    const wallet: WalletAdapter = {
      payInvoice: async () => ({ preimage: "x" }),
      diagnose: async () => ({
        kind: "nwc",
        balanceSats: 1353,
        methods: ["get_balance", "make_invoice"],
        canPayInvoices: false,
      }),
    };
    const source = new WalletSource(wallet, fakeL402());
    const text = (await source.callTool("wallet_status")).content[0].text;

    expect(text).toContain("Can pay invoices: NO");
    expect(text).toContain("NOT permitted to pay invoices");
    expect(text).toContain("pay_invoice permission");
  });

  test("a zero balance gets the top-up warning", async () => {
    const wallet: WalletAdapter = {
      payInvoice: async () => ({ preimage: "x" }),
      diagnose: async () => ({ kind: "lnbits", balanceSats: 0 }),
    };
    const text = (await new WalletSource(wallet).callTool("wallet_status")).content[0].text;
    expect(text).toContain("0 sats spendable");
    expect(text).toContain("Lightning channels");
  });

  test("probe limitations are listed, not hidden", async () => {
    const wallet: WalletAdapter = {
      payInvoice: async () => ({ preimage: "x" }),
      diagnose: async () => ({
        kind: "lnd",
        limitations: ["channel-balance probe refused (HTTP 403) — the macaroon may lack read permission"],
      }),
    };
    const text = (await new WalletSource(wallet).callTool("wallet_status")).content[0].text;
    expect(text).toContain("Probe limitations:");
    expect(text).toContain("HTTP 403");
  });

  test("an unreachable wallet is an error result that says payments will fail the same way", async () => {
    const wallet: WalletAdapter = {
      payInvoice: async () => ({ preimage: "x" }),
      diagnose: async () => {
        throw new Error("Failed to connect to wss://relay.example");
      },
    };
    const result = await new WalletSource(wallet).callTool("wallet_status");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("probe FAILED");
    expect(result.content[0].text).toContain("payments from this session will fail");
  });

  test("an adapter without diagnose() is stated plainly, not an error", async () => {
    const wallet: WalletAdapter = { payInvoice: async () => ({ preimage: "x" }) };
    const result = await new WalletSource(wallet).callTool("wallet_status");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no diagnostics");
  });

  test("lists exactly one read-only tool", () => {
    const wallet: WalletAdapter = { payInvoice: async () => ({ preimage: "x" }) };
    const tools = new WalletSource(wallet).listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("wallet_status");
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
  });
});

describe("paymentFailureHint", () => {
  const named = (name: string) => {
    const err = new Error("boom");
    err.name = name;
    return err;
  };

  test("fires for wallet-payment failures on both payment paths", () => {
    expect(paymentFailureHint(named("L402PaymentError"))).toContain("wallet_status");
    expect(paymentFailureHint(named("PaymentError"))).toContain("wallet_status");
  });

  test("stays silent for budget refusals and non-payment errors", () => {
    expect(paymentFailureHint(named("L402BudgetError"))).toBe("");
    expect(paymentFailureHint(named("PaymentBudgetError"))).toBe("");
    expect(paymentFailureHint(new Error("HTTP 500"))).toBe("");
    expect(paymentFailureHint("string error")).toBe("");
  });
});

/**
 * WalletSource — the `wallet_status` diagnostic for the SPENDING wallet.
 * `node_status` covers receiving nodes only; before this tool a failed
 * payment left no way to inspect the payer from the connector at all,
 * so isolation had to be done by elimination through unrelated tools
 * (2026-07-25 smoke finding F11). Present only when a wallet is
 * configured, unprefixed like the other native tools.
 */

import type { L402Client, ToolResult, WalletAdapter, WalletDiagnostics } from "@bolthub/pay";
import type { SourceTool, ToolSource } from "./source.js";

const DIAGNOSE_TIMEOUT_MS = 10_000;

/**
 * One-line pointer appended to payment-failure results by the paid tools:
 * the error text says what the wallet reported, this says where to look
 * next. Only fires for actual wallet-payment failures — budget refusals
 * and HTTP errors have nothing to diagnose on the payer side.
 */
export function paymentFailureHint(err: unknown): string {
  // L402PaymentError = gateway path, PaymentError = downstream TPP path.
  // Budget refusals (L402BudgetError / PaymentBudgetError) don't match:
  // exact name comparison is deliberate.
  return err instanceof Error && (err.name === "L402PaymentError" || err.name === "PaymentError")
    ? "\nRun wallet_status to inspect the SPENDING wallet (balance, permissions, connectivity)."
    : "";
}

export class WalletSource implements ToolSource {
  readonly key = "wallet";
  readonly kind = "wallet" as const;
  readonly namespaced = false;

  constructor(
    private wallet: WalletAdapter,
    private l402Client?: L402Client,
  ) {}

  async init(): Promise<void> {}

  listTools(): SourceTool[] {
    return [
      {
        name: "wallet_status",
        description:
          "Inspect the SPENDING wallet this session pays from: balance, permissions (can it pay invoices?), " +
          "identity, and connectivity. Use it to diagnose a failed payment — node_status covers RECEIVING " +
          "nodes (payout side), this covers the payer. Read-only; never moves funds.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
    ];
  }

  async callTool(name: string): Promise<ToolResult> {
    if (name !== "wallet_status") {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    if (!this.wallet.diagnose) {
      return {
        content: [
          {
            type: "text",
            text:
              "A spending wallet is configured, but this adapter exposes no diagnostics (payInvoice only). " +
              "Payments can still work; there is just nothing to probe here.",
          },
        ],
      };
    }

    let d: WalletDiagnostics;
    try {
      d = await withTimeout(this.wallet.diagnose(), DIAGNOSE_TIMEOUT_MS);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text:
              `Spending wallet probe FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
              "The wallet is unreachable or not responding — payments from this session will fail the same way. " +
              "Check that the wallet service is running and the connection credentials are current, then restart the connector.",
          },
        ],
        isError: true,
      };
    }

    const lines: string[] = [`Spending wallet: ${d.kind}`];
    if (d.balanceSats !== undefined) lines.push(`  Balance: ${d.balanceSats} sats`);
    if (d.alias) lines.push(`  Alias: ${d.alias}${d.network ? ` (network: ${d.network})` : ""}`);
    else if (d.network) lines.push(`  Network: ${d.network}`);
    if (d.pubkey) lines.push(`  Pubkey: ${d.pubkey}`);
    if (d.methods) lines.push(`  Permitted methods: ${d.methods.join(", ")}`);
    if (d.canPayInvoices !== undefined) {
      lines.push(`  Can pay invoices: ${d.canPayInvoices ? "yes" : "NO"}`);
    }
    if (d.limitations && d.limitations.length > 0) {
      lines.push("  Probe limitations:");
      for (const l of d.limitations) lines.push(`    - ${l}`);
    }

    if (d.canPayInvoices === false) {
      lines.push(
        "",
        "WARNING: this connection is NOT permitted to pay invoices — every paid call will fail. " +
          "Re-create the wallet connection with the pay_invoice permission (receive-only connection " +
          "strings are a common default) and restart the connector to pick it up.",
      );
    } else if (d.balanceSats === 0) {
      lines.push(
        "",
        "WARNING: the spending wallet reports 0 sats spendable — paid calls will fail until it is " +
          "topped up (funds must be in Lightning channels; on-chain balance doesn't count).",
      );
    }

    if (this.l402Client) {
      const spent = this.l402Client.totalSpent;
      const remaining = this.l402Client.remainingBudget;
      lines.push(
        "",
        remaining === Infinity
          ? `Session spending: ${spent} sats (no budget limit)`
          : `Session spending: ${spent} sats | Remaining budget: ${remaining} sats`,
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  async close(): Promise<void> {}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`wallet probe timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

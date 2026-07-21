/**
 * Finding 4 (2026-07-16 smoke test): a real paid call_api left the receipt
 * ledger empty while receipts were enabled. This exercises the full chain
 * the production server wires: ResolvedConfig.receipts →
 * createPaymentServices → L402Client recording → ReceiptsSource export.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WalletAdapter } from "@bolthub/pay";
import { createPaymentServices } from "../payment";
import { handleCallApi } from "../sources/marketplace-tools";
import { ReceiptsSource } from "../sources/receipts";
import type { ApiClient } from "../sources/api-client";

const originalFetch = globalThis.fetch;
let scratchDir: string | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = undefined;
});

const PREIMAGE = "ab".repeat(32);

const wallet: WalletAdapter = {
  async payInvoice() {
    return { preimage: PREIMAGE };
  },
};

const apiClient = {
  getGatewayUrl: (slug: string, path: string) => `https://${slug}.gw.test${path}`,
} as unknown as ApiClient;

/** 402 with a priced challenge on the first hit, 200 once paid. */
function mockGateway(priceSat: number, headers: Record<string, string> = {}) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ amountSats: priceSat }), {
        status: 402,
        headers: { "WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc_gateway"' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "X-Bolthub-Payment": "charged", ...headers },
    });
  }) as typeof fetch;
}

function servicesWithReceipts() {
  scratchDir = mkdtempSync(join(tmpdir(), "bolthub-receipts-test-"));
  const receiptsPath = join(scratchDir, "receipts.jsonl");
  const services = createPaymentServices(
    {
      gateways: [],
      mcpServers: {},
      budget: { sat: 100 },
      maxPerCall: {},
      telemetry: false,
      receipts: { path: receiptsPath },
    } as never,
    wallet,
  );
  return services;
}

async function exportVia(services: ReturnType<typeof servicesWithReceipts>, args: Record<string, unknown> = {}) {
  // Same wiring as index.ts: ledger path + recording health from the client.
  const source = new ReceiptsSource(services.receiptStore!, {
    ledgerPath: services.receiptsPath,
    recordingHealth: services.l402Client
      ? () => services.l402Client!.receiptRecordingFailures
      : undefined,
  });
  const result = await source.callTool("export_receipts", args);
  return result.content[0].text;
}

describe("receipts end-to-end: paid call_api → export_receipts", () => {
  test("one paid call records exactly one receipt with a non-empty preimage", async () => {
    const services = servicesWithReceipts();
    mockGateway(3);

    const result = await handleCallApi(
      { slug: "btc-intel", path: "/v1/market/snapshot" },
      apiClient,
      services.l402Client,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("charged");

    const json = await exportVia(services, { format: "json" });
    expect(json).toContain("1 receipt(s):");
    const rows = JSON.parse(json.slice(json.indexOf("\n") + 1)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].preimage).toBe(PREIMAGE);
    expect(rows[0].amount_sats).toBe(3);
    expect(rows[0].outcome).toBe("charged");

    // redact strips the preimage but keeps the row
    const redacted = await exportVia(services, { format: "json", redact: true });
    expect(redacted).toContain("1 receipt(s):");
    expect(redacted).not.toContain(PREIMAGE);
    expect(redacted).toContain("REDACTED");
  });

  test("a free call records nothing; the empty state names the ledger and non-retroactivity", async () => {
    const services = servicesWithReceipts();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    const result = await handleCallApi(
      { slug: "btc-intel", path: "/v1/free" },
      apiClient,
      services.l402Client,
    );
    expect(result.isError).toBeUndefined();
    const text = await exportVia(services);
    expect(text).toContain("No receipts recorded");
    expect(text).toContain(`Ledger: ${services.receiptsPath}`);
    expect(text).toContain("never backfilled");
    expect(text).not.toContain("WARNING");
  });

  test("a failed receipt write is LOUD in the export output, and the paid call still succeeds", async () => {
    // Point the ledger INSIDE a regular file so every append throws — the
    // silent-persistence-failure shape from finding 4.
    scratchDir = mkdtempSync(join(tmpdir(), "bolthub-receipts-test-"));
    const blocker = join(scratchDir, "blocker");
    writeFileSync(blocker, "i am a file, not a directory");
    const services = createPaymentServices(
      {
        gateways: [],
        mcpServers: {},
        budget: { sat: 100 },
        maxPerCall: {},
        telemetry: false,
        receipts: { path: join(blocker, "receipts.jsonl") },
      } as never,
      wallet,
    );
    mockGateway(3);

    const result = await handleCallApi(
      { slug: "btc-intel", path: "/v1/market/snapshot" },
      apiClient,
      services.l402Client,
    );
    expect(result.isError).toBeUndefined(); // the paid call itself must not fail

    const text = await exportVia(services);
    expect(text).toContain("No receipts recorded");
    expect(text).toContain("WARNING: 1 receipt write(s) FAILED");
    expect(text).toContain("ledger location is writable");
  });

  test("a credit draw (cached credential, no new payment) records nothing new", async () => {
    const services = servicesWithReceipts();
    // Simulate a draw: the gateway accepts the presented credential
    // outright (200, prepaid_use), so no payment happens in this call.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "X-Bolthub-Payment": "prepaid_use" },
      })) as unknown as typeof fetch;

    const result = await handleCallApi(
      { slug: "btc-intel", path: "/v1/market/snapshot" },
      apiClient,
      services.l402Client,
    );
    expect(result.isError).toBeUndefined();
    expect(await exportVia(services)).toContain("No receipts recorded");
  });
});

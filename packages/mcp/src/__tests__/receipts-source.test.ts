import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryReceiptStore, type Receipt } from "@bolthub/pay";
import { ReceiptsSource } from "../sources/receipts";
import { parseArgs, resolveConfig } from "../config";

function writeConfig(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bolthub-mcp-test-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
}

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_v: 1,
    ts: "2026-07-09T12:00:00.000Z",
    resource: "https://acme.gw.bolthub.ai/v1/data",
    method: "GET",
    amount_sats: 10,
    payment_hash: "hash123",
    preimage: "ab".repeat(32),
    invoice: "lnbc1000...",
    outcome: "charged",
    ...overrides,
  };
}

describe("receipts config resolution", () => {
  test("off by default — nothing configured, nothing recorded", () => {
    const config = resolveConfig(parseArgs(["node", "mcp"]), {});
    expect(config.receipts).toBeUndefined();
  });

  test("--receipts <path> wins over env; 'default' means the store default", () => {
    const flagged = resolveConfig(
      parseArgs(["node", "mcp", "--receipts", "/tmp/r.jsonl"]),
      { RECEIPTS_PATH: "/elsewhere.jsonl" },
    );
    expect(flagged.receipts).toEqual({ path: "/tmp/r.jsonl" });

    const dflt = resolveConfig(parseArgs(["node", "mcp", "--receipts", "default"]), {});
    expect(dflt.receipts).toEqual({});
  });

  test("RECEIPTS_PATH env enables recording when nothing else does", () => {
    const config = resolveConfig(parseArgs(["node", "mcp"]), {
      RECEIPTS_PATH: "/tmp/env-receipts.jsonl",
    });
    expect(config.receipts).toEqual({ path: "/tmp/env-receipts.jsonl" });
  });

  // 2026-07-24 smoke test, step 11: `true` passed as a value became the
  // ledger PATH — open('true') in Claude Desktop's read-only cwd, EROFS,
  // zero rows exported despite correct recording. Boolean-looking values
  // must act as switches everywhere a receipts string can arrive.
  test("boolean-looking values are switches, never ledger paths", () => {
    const flagTrue = resolveConfig(parseArgs(["node", "mcp", "--receipts", "true"]), {});
    expect(flagTrue.receipts).toEqual({});

    const envTrue = resolveConfig(parseArgs(["node", "mcp"]), { RECEIPTS_PATH: "TRUE" });
    expect(envTrue.receipts).toEqual({});

    const fileString = resolveConfig(
      parseArgs(["node", "mcp", "--config", writeConfig({ receipts: "true" })]),
      {},
    );
    expect(fileString.receipts).toEqual({});
  });

  test("--receipts false switches recording off, overriding file and env", () => {
    const config = resolveConfig(
      parseArgs(["node", "mcp", "--config", writeConfig({ receipts: true }), "--receipts", "false"]),
      { RECEIPTS_PATH: "/elsewhere.jsonl" },
    );
    expect(config.receipts).toBeUndefined();
  });

  test("a path that merely contains a boolean word is still a path", () => {
    const config = resolveConfig(parseArgs(["node", "mcp", "--receipts", "./true"]), {});
    expect(config.receipts).toEqual({ path: "./true" });
  });
});

describe("ReceiptsSource", () => {
  test("exposes export_receipts unprefixed", () => {
    const source = new ReceiptsSource(new InMemoryReceiptStore());
    expect(source.namespaced).toBe(false);
    expect(source.listTools().map((t) => t.name)).toEqual(["export_receipts"]);
  });

  test("exports receipts as json with a count header", async () => {
    const store = new InMemoryReceiptStore();
    store.append(makeReceipt());
    const source = new ReceiptsSource(store);

    const result = await source.callTool("export_receipts", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("1 receipt(s):");
    expect(result.content[0].text).toContain('"payment_hash": "hash123"');
  });

  test("csv + redact strips preimages", async () => {
    const store = new InMemoryReceiptStore();
    store.append(makeReceipt());
    const source = new ReceiptsSource(store);

    const result = await source.callTool("export_receipts", { format: "csv", redact: true });
    expect(result.content[0].text).toContain("receipt_v,ts,resource");
    expect(result.content[0].text).toContain("REDACTED");
    expect(result.content[0].text).not.toContain("ab".repeat(32));
  });

  test("range filtering and empty-result message", async () => {
    const store = new InMemoryReceiptStore();
    store.append(makeReceipt({ ts: "2026-07-01T00:00:00.000Z" }));
    const source = new ReceiptsSource(store);

    const empty = await source.callTool("export_receipts", { from: "2026-07-05T00:00:00Z" });
    expect(empty.content[0].text).toContain("No receipts recorded");

    const bad = await source.callTool("export_receipts", { from: "not-a-date" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("Invalid from");
  });
});

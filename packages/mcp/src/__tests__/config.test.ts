import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseArgs, resolveConfig, loadConfigFile } from "../config";

function writeConfig(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bolthub-mcp-test-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
}

function argv(...args: string[]): string[] {
  return ["node", "bolthub-mcp", ...args];
}

describe("parseArgs", () => {
  test("parses flags", () => {
    const cli = parseArgs(
      argv("--config", "/tmp/c.json", "--gateway", "https://a.gw.bolthub.ai", "--gateway", "https://b.gw.bolthub.ai", "--budget", "500", "--no-marketplace"),
    );
    expect(cli.configPath).toBe("/tmp/c.json");
    expect(cli.gateways).toEqual(["https://a.gw.bolthub.ai", "https://b.gw.bolthub.ai"]);
    expect(cli.budgetSats).toBe(500);
    expect(cli.marketplace).toBe(false);
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(argv("--frobnicate"))).toThrow(/Unknown flag/);
  });

  test("rejects a negative budget", () => {
    expect(() => parseArgs(argv("--budget", "-5"))).toThrow(/non-negative/);
  });

  test("rejects a budget with trailing garbage (parseInt would truncate '500k' to 500)", () => {
    expect(() => parseArgs(argv("--budget", "500k"))).toThrow(/non-negative integer/);
    expect(() => parseArgs(argv("--budget", "5.5"))).toThrow(/non-negative integer/);
    expect(() => parseArgs(argv("--budget", "1e4"))).toThrow(/non-negative integer/);
    expect(() => parseArgs(argv("--max-per-call", "50k"))).toThrow(/non-negative integer/);
  });

  test("rejects a missing budget value", () => {
    expect(() => parseArgs(argv("--budget"))).toThrow(/Missing value/);
  });
});

describe("resolveConfig", () => {
  test("zero config = marketplace-only mode", () => {
    const cfg = resolveConfig(parseArgs(argv()), {});
    expect(cfg.marketplace).toEqual({});
    expect(cfg.gateways).toEqual([]);
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.namespace).toBe("prefix");
  });

  test("--gateway with no config file = gateway-only (marketplace off)", () => {
    const cfg = resolveConfig(parseArgs(argv("--gateway", "https://btc-intel.gw.bolthub.ai")), {});
    expect(cfg.marketplace).toBeUndefined();
    expect(cfg.gateways).toEqual([{ url: "https://btc-intel.gw.bolthub.ai" }]);
  });

  test("config file with sources leaves marketplace off unless asked", () => {
    const path = writeConfig({ gateways: ["https://a.gw.bolthub.ai"] });
    const cfg = resolveConfig(parseArgs(argv("--config", path)), {});
    expect(cfg.marketplace).toBeUndefined();
    expect(cfg.gateways).toHaveLength(1);
  });

  test("config file with ONLY a budget still defaults marketplace on", () => {
    const path = writeConfig({ budget: { sat: 1000 } });
    const cfg = resolveConfig(parseArgs(argv("--config", path)), {});
    expect(cfg.marketplace).toEqual({});
    expect(cfg.budget.sat).toBe(1000);
  });

  test("precedence: CLI beats file beats env", () => {
    const path = writeConfig({ budget: { sat: 2000 } });
    const fromFile = resolveConfig(parseArgs(argv("--config", path)), { BUDGET_SATS: "3000" });
    expect(fromFile.budget.sat).toBe(2000);
    const fromCli = resolveConfig(parseArgs(argv("--config", path, "--budget", "100")), {
      BUDGET_SATS: "3000",
    });
    expect(fromCli.budget.sat).toBe(100);
    const fromEnv = resolveConfig(parseArgs(argv()), { BUDGET_SATS: "3000" });
    expect(fromEnv.budget.sat).toBe(3000);
  });

  test("budget of 0 via CLI is respected (free-tools-only mode)", () => {
    const cfg = resolveConfig(parseArgs(argv("--budget", "0")), { BUDGET_SATS: "500" });
    expect(cfg.budget.sat).toBe(0);
  });

  test("BUDGET_SATS=0 means free-tools-only, not unlimited", () => {
    const cfg = resolveConfig(parseArgs(argv()), { BUDGET_SATS: "0" });
    expect(cfg.budget.sat).toBe(0);
    expect(cfg.budgetSatSource).toBe("env");
  });

  test("malformed BUDGET_SATS aborts startup instead of widening to unlimited", () => {
    expect(() => resolveConfig(parseArgs(argv()), { BUDGET_SATS: "abc" })).toThrow(
      /BUDGET_SATS expects a non-negative integer/,
    );
    expect(() => resolveConfig(parseArgs(argv()), { BUDGET_SATS: "-100" })).toThrow(
      /BUDGET_SATS expects a non-negative integer/,
    );
    expect(() => resolveConfig(parseArgs(argv()), { BUDGET_SATS: "500k" })).toThrow(
      /BUDGET_SATS expects a non-negative integer/,
    );
  });

  test("malformed BUDGET_SATS aborts even when a valid --budget would win", () => {
    // Fail-loud beats fail-quiet: an env var the user believes is in effect
    // must never be silently discarded, even when overridden.
    expect(() => resolveConfig(parseArgs(argv("--budget", "500")), { BUDGET_SATS: "oops" })).toThrow(
      /BUDGET_SATS/,
    );
  });

  test("empty BUDGET_SATS is treated as unset", () => {
    const cfg = resolveConfig(parseArgs(argv()), { BUDGET_SATS: "" });
    expect(cfg.budget.sat).toBeUndefined();
    expect(cfg.budgetSatSource).toBeUndefined();
  });

  test("budgetSatSource names the winner of flag > file > env", () => {
    const path = writeConfig({ budget: { sat: 2000 } });
    expect(
      resolveConfig(parseArgs(argv("--config", path, "--budget", "100")), { BUDGET_SATS: "3000" })
        .budgetSatSource,
    ).toBe("flag");
    expect(
      resolveConfig(parseArgs(argv("--config", path)), { BUDGET_SATS: "3000" }).budgetSatSource,
    ).toBe("file");
    expect(resolveConfig(parseArgs(argv()), { BUDGET_SATS: "3000" }).budgetSatSource).toBe("env");
    expect(resolveConfig(parseArgs(argv()), {}).budgetSatSource).toBeUndefined();
  });

  test("mcpServers keys with '__' are rejected", () => {
    const path = writeConfig({
      mcpServers: { bad__key: { command: "npx", args: ["x"] } },
    });
    expect(() => loadConfigFile(path)).toThrow(/__/);
  });

  test("remote mcpServers entries accept url + headers", () => {
    const path = writeConfig({
      mcpServers: { remote: { url: "https://tools.example.com/mcp", headers: { Authorization: "Bearer x" } } },
    });
    const cfg = resolveConfig(parseArgs(argv("--config", path)), {});
    expect(cfg.mcpServers.remote).toEqual({
      url: "https://tools.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  test("unknown top-level keys are a config error (catch typos)", () => {
    const path = writeConfig({ gatways: ["https://a.gw.bolthub.ai"] });
    expect(() => loadConfigFile(path)).toThrow(/invalid/i);
  });

  test("missing explicit config path throws", () => {
    expect(() => resolveConfig(parseArgs(argv("--config", "/nonexistent/mcp.json")), {})).toThrow(
      /not found/,
    );
  });
});

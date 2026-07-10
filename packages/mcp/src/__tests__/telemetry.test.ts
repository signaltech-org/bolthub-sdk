import { describe, test, expect, mock, afterEach } from "bun:test";
import { auditMint, auditRevoke, audit } from "../telemetry";

// Audit lines go to stderr (console.error) — stdout is the MCP JSON-RPC channel.
// AF-D9: mint/revoke each emit one structured line with scope parameters.

const realError = console.error;
afterEach(() => {
  console.error = realError;
});

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  console.error = mock((msg: string) => lines.push(msg)) as any;
  fn();
  return lines;
}

describe("delegation audit lines", () => {
  test("auditMint emits one line with every scope parameter", () => {
    const lines = captureStderr(() =>
      auditMint({ resource: "acme/v1/data", nUses: 50, maxSats: 300, pathPrefix: "/v1/data", expiryMs: 0 }),
    );
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("mint scoped token → acme/v1/data");
    expect(line).toContain("n_uses=50");
    expect(line).toContain("max_sats=300");
    expect(line).toContain("path_prefix=/v1/data");
    expect(line).toContain("expiry=1970-01-01T00:00:00.000Z");
  });

  test("auditMint notes an unrestricted mint rather than an empty scope", () => {
    const lines = captureStderr(() => auditMint({ resource: "acme/v1/data" }));
    expect(lines[0]).toContain("[no restriction]");
  });

  test("auditRevoke emits one line, with the released amount when present", () => {
    expect(captureStderr(() => auditRevoke({ resource: "acme/v1/data" }))[0]).toBe(
      "[bolthub-mcp] revoke token → acme/v1/data",
    );
    expect(captureStderr(() => auditRevoke({ resource: "acme/v1/data", releasedSats: 300 }))[0]).toContain(
      "released 300 sats",
    );
  });

  test("payment audit line is unchanged", () => {
    const lines = captureStderr(() => audit({ scheme: "l402", amount: 8000, asset: "sat", resource: "acme/v1/data" }));
    expect(lines[0]).toBe("[bolthub-mcp] paid 8000 sat via l402 → acme/v1/data");
  });
});

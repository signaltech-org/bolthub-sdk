import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleConnectAccount,
  handleConnectStatus,
  readStoredToken,
  resetPendingPairing,
} from "../sources/connect-tools";
import { resolveAccountToken } from "../sources/seller-tools";

const API = "https://api.test";

const PAIRING = {
  pairingId: "11111111-2222-3333-4444-555555555555",
  deviceSecret: "device-secret-abcdef1234567890",
  displayCode: "ABCD-EFGH",
  verificationUri: "https://bolthub.ai/connect/tok123",
  expiresAt: "2026-07-13T13:00:00.000Z",
  pollIntervalMs: 3000,
};

const originalFetch = globalThis.fetch;
let tmpDir: string;
let requests: Array<{ path: string; body: unknown }> = [];

function mockApi(routes: Record<string, unknown>) {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ path: url.pathname, body });
    const payload = routes[url.pathname];
    if (payload === undefined) {
      return new Response(JSON.stringify({ error: `no mock for ${url.pathname}` }), { status: 404 });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bolthub-connect-"));
  process.env.BOLTHUB_CREDENTIALS_PATH = join(tmpDir, "nested", "credentials.json");
  resetPendingPairing();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.BOLTHUB_CREDENTIALS_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleConnectAccount", () => {
  test("starts a pairing and surfaces link + code, never the device secret", async () => {
    mockApi({ "/mcp-pairings": { pairing: PAIRING } });
    const result = await handleConnectAccount({}, API, undefined);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain(PAIRING.verificationUri);
    expect(text).toContain(PAIRING.displayCode);
    expect(text).toContain("connect_status");
    expect(text).not.toContain(PAIRING.deviceSecret);
    // default label carries the host machine name
    expect((requests[0].body as { label: string }).label).toContain("Claude Desktop on ");
  });

  test("refuses to pair over an existing token", async () => {
    mockApi({});
    const result = await handleConnectAccount({}, API, "bh_pat_existing");
    expect(result.content[0].text).toContain("already configured");
    expect(requests).toHaveLength(0);
  });
});

describe("handleConnectStatus", () => {
  test("without a pairing: reports configured token or points at connect_account", async () => {
    mockApi({});
    const connected = await handleConnectStatus({}, API, "bh_pat_configured00");
    expect(connected.content[0].text).toContain("Connected");
    expect(connected.content[0].text).not.toContain("bh_pat_configured00"); // prefix only
    const idle = await handleConnectStatus({}, API, undefined);
    expect(idle.content[0].text).toContain("connect_account");
  });

  test("pending approval keeps the pairing and re-shows the link", async () => {
    mockApi({
      "/mcp-pairings": { pairing: PAIRING },
      "/mcp-pairings/claim": { result: { status: "pending" } },
    });
    await handleConnectAccount({}, API, undefined);
    const result = await handleConnectStatus({}, API, undefined);
    expect(result.content[0].text).toContain("Not approved yet");
    expect(result.content[0].text).toContain(PAIRING.displayCode);
  });

  test("approved claim writes credentials (0600) and reports prefix only", async () => {
    mockApi({
      "/mcp-pairings": { pairing: PAIRING },
      "/mcp-pairings/claim": {
        result: {
          status: "approved",
          token: "bh_pat_fulltokenvalue123",
          prefix: "bh_pat_fullt",
          tokenExpiresAt: "2026-10-11T00:00:00.000Z",
        },
      },
    });
    await handleConnectAccount({}, API, undefined);
    const result = await handleConnectStatus({}, API, undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("bh_pat_fullt…");
    expect(result.content[0].text).not.toContain("bh_pat_fulltokenvalue123");

    const path = process.env.BOLTHUB_CREDENTIALS_PATH!;
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.accountToken).toBe("bh_pat_fulltokenvalue123");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // the claim consumed the pairing: next status call reads the stored token
    expect(readStoredToken()).toBe("bh_pat_fulltokenvalue123");
    const after = await handleConnectStatus({}, API, readStoredToken());
    expect(after.content[0].text).toContain("Connected");
  });

  test("expired claim clears the pairing and suggests a rerun", async () => {
    mockApi({
      "/mcp-pairings": { pairing: PAIRING },
      "/mcp-pairings/claim": { result: { status: "expired" } },
    });
    await handleConnectAccount({}, API, undefined);
    const result = await handleConnectStatus({}, API, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("connect_account");
  });
});

describe("resolveAccountToken file fallback", () => {
  test("env wins over stored credentials; file used when env absent", async () => {
    mockApi({
      "/mcp-pairings": { pairing: PAIRING },
      "/mcp-pairings/claim": {
        result: {
          status: "approved",
          token: "bh_pat_stored",
          prefix: "bh_pat_sto",
          tokenExpiresAt: "2026-10-11T00:00:00.000Z",
        },
      },
    });
    await handleConnectAccount({}, API, undefined);
    await handleConnectStatus({}, API, undefined);

    expect(resolveAccountToken({})).toBe("bh_pat_stored");
    expect(resolveAccountToken({ BOLTHUB_ACCOUNT_TOKEN: "bh_pat_env" })).toBe("bh_pat_env");
    expect(resolveAccountToken({ BOLTHUB_AUTH_TOKEN: "legacy" })).toBe("legacy");
  });

  test("missing or malformed credentials file reads as undefined", () => {
    expect(readStoredToken()).toBeUndefined();
  });
});

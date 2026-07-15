/**
 * One-click account connect (onboarding-v2 D2): device-grant pairing,
 * Stripe-style. `connect_account` creates a pairing session and drops the
 * approval link + confirmation code into the chat; the user approves in a
 * logged-in dashboard tab; `connect_status` claims the minted account token
 * and stores it at ~/.bolthub/credentials.json (0600).
 *
 * The tool NEVER opens a browser or binds a port (unreliable for a process
 * spawned by an MCP client, and the approval may happen on another device).
 * The minted token is written to disk and never echoed into the chat.
 */

import { hostname, homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const DEFAULT_API_URL = "https://api.bolthub.ai";

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function credentialsPath(): string {
  return process.env.BOLTHUB_CREDENTIALS_PATH ?? join(homedir(), ".bolthub", "credentials.json");
}

/** Stored-token read for resolveAccountToken's fallback. Never throws. */
export function readStoredToken(): string | undefined {
  try {
    const raw = readFileSync(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as { accountToken?: unknown };
    return typeof parsed.accountToken === "string" && parsed.accountToken
      ? parsed.accountToken
      : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredToken(token: string, meta: { prefix: string; expiresAt?: string }): void {
  const path = credentialsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify(
      { accountToken: token, prefix: meta.prefix, expiresAt: meta.expiresAt ?? null },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

interface PendingPairing {
  pairingId: string;
  deviceSecret: string;
  displayCode: string;
  verificationUri: string;
  expiresAt: string;
}

// In-memory only: survives across tool calls within one server process
// (MCP clients keep the stdio server alive). A restart mid-pairing just
// means running connect_account again — sessions are cheap and expire fast.
let pending: PendingPairing | null = null;

/** Test hook. */
export function resetPendingPairing(): void {
  pending = null;
}

async function pairingRequest<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `API returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function handleConnectAccount(
  args: { label?: string },
  apiUrl?: string,
  existingToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;
  if (existingToken) {
    return textResult(
      "An account token is already configured (env or stored credentials). Run connect_status to see it, or revoke it in the dashboard (Settings → MCP setup) before pairing again.",
    );
  }

  try {
    const { pairing } = await pairingRequest<{ pairing: PendingPairing & { pollIntervalMs: number } }>(
      baseUrl,
      "/mcp-pairings",
      { label: args.label ?? `Claude Desktop on ${hostname()}` },
    );
    pending = pairing;
    return textResult(
      [
        "Account pairing started. Ask the user to:",
        "",
        `1. Open: ${pairing.verificationUri}`,
        `2. Check the code on that page matches: ${pairing.displayCode}`,
        "3. Click Approve (they may need to log in first)",
        "",
        "The link expires in 10 minutes. Once the user says they've approved, call connect_status to finish. The account token is stored locally and never appears in this chat.",
      ].join("\n"),
    );
  } catch (err) {
    return errorResult(
      `connect_account failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function handleConnectStatus(
  _args: Record<string, never>,
  apiUrl?: string,
  existingToken?: string,
): Promise<ToolResult> {
  const baseUrl = apiUrl ?? DEFAULT_API_URL;

  if (!pending) {
    if (existingToken) {
      return textResult(
        `Connected. An account token is configured (${existingToken.slice(0, 13)}…). Seller tools are ready — try usage_summary or list_api.`,
      );
    }
    return textResult("No pairing in progress and no token configured. Run connect_account to start.");
  }

  try {
    const { result } = await pairingRequest<{
      result:
        | { status: "pending" }
        | { status: "expired" }
        | { status: "approved"; token: string; prefix: string; tokenExpiresAt: string };
    }>(baseUrl, "/mcp-pairings/claim", {
      pairingId: pending.pairingId,
      deviceSecret: pending.deviceSecret,
    });

    if (result.status === "pending") {
      return textResult(
        `Not approved yet. The user still needs to open ${pending.verificationUri} and approve (code ${pending.displayCode}). Check again after they confirm.`,
      );
    }
    if (result.status === "expired") {
      pending = null;
      return errorResult(
        "The pairing expired or was already used. Run connect_account to start a fresh one.",
      );
    }

    writeStoredToken(result.token, {
      prefix: result.prefix,
      expiresAt: result.tokenExpiresAt,
    });
    pending = null;
    return textResult(
      [
        `Connected. Account token ${result.prefix}… stored at ${credentialsPath()} (valid ~90 days; revocable in dashboard → Settings → MCP setup).`,
        "Seller tools are ready — try usage_summary for a first look, or list_api to draft a listing.",
      ].join("\n"),
    );
  } catch (err) {
    return errorResult(
      `connect_status failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Spend audit: every successful payment logs ONE line to stderr — the user's
 * own local audit trail (stdout is the MCP channel; never log there).
 *
 * The `telemetry` config flag is RESERVED: it is validated and documented,
 * but v1 sends nothing anywhere, on or off. If a future version adds an
 * opt-in ingest it will carry `{ scheme, asset, amount }` only — no tool
 * arguments, no resource identity. Keep this promise in the README verbatim.
 */

import { log } from "./log";

export interface PaidInfo {
  scheme: string;
  amount: number;
  asset: string;
  resource: string;
}

export function audit(info: PaidInfo): void {
  log(`paid ${info.amount} ${info.asset} via ${info.scheme} → ${info.resource}`);
}

export interface MintAuditInfo {
  resource: string;
  nUses?: number;
  maxSats?: number;
  pathPrefix?: string;
  expiryMs?: number;
}

/**
 * One audit line per delegated-token mint (AF-D9). Minting is OFFLINE — the
 * gateway never sees it until a child is spent — so the parent's own stderr is
 * the only place a mint is recorded. Carries the scope parameters so the trail
 * shows exactly what each child was allowed.
 */
export function auditMint(info: MintAuditInfo): void {
  const scope = [
    info.nUses != null ? `n_uses=${info.nUses}` : null,
    info.maxSats != null ? `max_sats=${info.maxSats}` : null,
    info.pathPrefix != null ? `path_prefix=${info.pathPrefix}` : null,
    info.expiryMs != null ? `expiry=${new Date(info.expiryMs).toISOString()}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  log(`mint scoped token → ${info.resource} [${scope || "no restriction"}]`);
}

/** One audit line per revoke (AF-D9); the gateway logs its own server-side line. */
export function auditRevoke(info: { resource: string; releasedSats?: number }): void {
  const released = info.releasedSats ? ` (released ${info.releasedSats} sats)` : "";
  log(`revoke token → ${info.resource}${released}`);
}

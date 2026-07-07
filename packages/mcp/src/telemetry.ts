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

import { importMacaroon } from "macaroon";

export interface AttenuateOptions {
  /** Restrict the credential to a single HTTP method, e.g. "GET". */
  method?: string;
  /** A tighter expiry than the macaroon's own, as Unix milliseconds or a Date. */
  validUntil?: number | Date;
}

/**
 * Narrow an L402 macaroon OFFLINE by appending first-party caveats, so a parent
 * agent can delegate a *restricted* credential to a sub-agent without contacting
 * bolthub or re-paying. This is the macaroon "attenuation" property: anyone
 * holding a macaroon can append caveats offline.
 *
 * `macaroonB64` is the value from the `L402 <macaroon>:<preimage>` credential
 * (equivalently the `macaroon="..."` field of the 402 challenge). Hand the
 * result plus the SAME preimage to the sub-agent, which authenticates with
 * `Authorization: L402 <attenuated>:<preimage>`. The bolthub gateway enforces
 * every caveat down the chain (most restrictive wins).
 *
 * Node/agent-side helper; not exported from the browser build.
 */
export function attenuate(macaroonB64: string, opts: AttenuateOptions): string {
  const caveats = buildCaveats(opts);
  if (caveats.length === 0) {
    throw new Error(
      "attenuate() needs at least one restriction (method or validUntil)",
    );
  }
  const m = importMacaroon(base64ToBytes(macaroonB64));
  for (const c of caveats) m.addFirstPartyCaveat(c);
  return bytesToBase64(m.exportBinary());
}

function buildCaveats(opts: AttenuateOptions): string[] {
  const out: string[] = [];
  if (opts.method) out.push(`method=${opts.method}`);
  if (opts.validUntil != null) {
    const ms =
      opts.validUntil instanceof Date ? opts.validUntil.getTime() : opts.validUntil;
    out.push(`valid_until=${Math.floor(ms)}`);
  }
  return out;
}

// Browser- and Node-safe base64 <-> bytes (atob/btoa are globals in both). The
// wire field uses standard base64, matching the gateway.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

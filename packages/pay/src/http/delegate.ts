import { importMacaroon, type Macaroon } from "macaroon";
import { normalizePathPrefix, pathMatchesPrefix, parseCaveatInt } from "./path-caveat";

export interface AttenuateOptions {
  /** Restrict the credential to a single HTTP method, e.g. "GET". */
  method?: string;
  /** A tighter expiry than the macaroon's own, as Unix milliseconds or a Date. */
  validUntil?: number | Date;
  /**
   * Cap total remaining requests (caveat schema v2). May only *lower* an
   * `n_uses` the credential already carries — a child can never grant itself
   * more uses than its parent.
   */
  nUses?: number;
  /**
   * Cap cumulative spend in sats (caveat schema v2). Enforced on
   * `per_request` endpoints where the per-call price is known. May only lower
   * an existing `max_sats`.
   */
  maxSats?: number;
  /**
   * Restrict to request paths at or under this prefix (caveat schema v2). The
   * value is normalized (DESIGN.md §3) and must be at or under any
   * `path_prefix` the credential already carries — a child can never widen the
   * path scope.
   */
  pathPrefix?: string;
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
 * Attenuation is **tighten-only**: this helper validates each restriction
 * against the caveats the macaroon already carries and throws if the caller
 * tries to raise `n_uses`/`max_sats`, widen `path_prefix`, or push `validUntil`
 * later than an existing bound. The gateway verifier enforces the same folds
 * server-side (min / most-specific-prefix), so a bypass of this check still
 * cannot escalate; the check just fails fast instead of minting a token that
 * silently behaves tighter than asked.
 *
 * Node/agent-side helper; not exported from the browser build.
 */
export function attenuate(macaroonB64: string, opts: AttenuateOptions): string {
  const m = importMacaroon(base64ToBytes(macaroonB64));
  const caveats = buildCaveats(opts, existingBounds(m));
  if (caveats.length === 0) {
    throw new Error(
      "attenuate() needs at least one restriction (method, validUntil, nUses, maxSats, or pathPrefix)",
    );
  }
  for (const c of caveats) m.addFirstPartyCaveat(c);
  return bytesToBase64(exportMacaroonBinaryV2(m));
}

/**
 * The effective (tightest) bound the macaroon already carries per v2 caveat,
 * so buildCaveats can reject a widening attenuation. Mirrors the verifier fold:
 * `n_uses`/`max_sats` = minimum, `valid_until` = earliest, `path_prefix` =
 * longest (most specific). Malformed existing caveats are skipped here; the
 * gateway verifier is the authority that rejects them.
 */
interface ExistingBounds {
  nUses?: number;
  maxSats?: number;
  validUntilMs?: number;
  pathPrefix?: string;
}

function existingBounds(m: Macaroon): ExistingBounds {
  const b: ExistingBounds = {};
  const dec = new TextDecoder();
  for (const c of m.caveats) {
    let id: string;
    try {
      id = dec.decode(c.identifier);
    } catch {
      continue;
    }
    const eq = id.indexOf("=");
    if (eq < 0) continue;
    const key = id.slice(0, eq);
    const val = id.slice(eq + 1);
    try {
      if (key === "n_uses") b.nUses = Math.min(b.nUses ?? Infinity, parseCaveatInt(val));
      else if (key === "max_sats") b.maxSats = Math.min(b.maxSats ?? Infinity, parseCaveatInt(val));
      else if (key === "valid_until") {
        const ms = Number(val);
        if (Number.isFinite(ms)) b.validUntilMs = Math.min(b.validUntilMs ?? Infinity, ms);
      } else if (key === "path_prefix") {
        const norm = normalizePathPrefix(val);
        // Keep the longest (most specific) existing prefix as the ceiling.
        if (b.pathPrefix === undefined || norm.length > b.pathPrefix.length) b.pathPrefix = norm;
      }
    } catch {
      // Skip a malformed existing caveat; the verifier fails it closed.
    }
  }
  return b;
}

// Serialise a macaroon to the libmacaroons v2 binary format from the library's
// public byte getters. We do NOT use the library's own `exportBinary()`: its
// internal ByteBuffer never initialises a capacity field, so its grow check
// (`minCap <= this._capacity`, i.e. `<= undefined`) is always false and the
// buffer doubles on every append. A macaroon with several caveats (every real
// L402 token: header + 4 binding caveats + signature) overflows the max typed
// array size and throws `RangeError: length too large`. The crypto — the HMAC
// signature chaining in `addFirstPartyCaveat` — is unaffected and stays the
// library's; only the framing below is ours. Field types and section layout
// follow the spec: version, header (location?, identifier, EOS), each caveat
// (location?, identifier, vid?, EOS), an end-of-caveats EOS, then the signature.
function exportMacaroonBinaryV2(m: Macaroon): Uint8Array {
  const FIELD_EOS = 0;
  const FIELD_LOCATION = 1;
  const FIELD_IDENTIFIER = 2;
  const FIELD_VID = 4;
  const FIELD_SIGNATURE = 6;
  const out: number[] = [];
  const uvarint = (x: number) => {
    while (x >= 0x80) {
      out.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    out.push(x);
  };
  const field = (type: number, data?: Uint8Array) => {
    uvarint(type);
    if (data) {
      uvarint(data.length);
      for (let i = 0; i < data.length; i++) out.push(data[i]);
    }
  };

  out.push(2); // version
  if (m.location) field(FIELD_LOCATION, utf8(m.location));
  field(FIELD_IDENTIFIER, m.identifier);
  field(FIELD_EOS);
  for (const c of m.caveats) {
    if (c.location) field(FIELD_LOCATION, utf8(c.location));
    field(FIELD_IDENTIFIER, c.identifier);
    if (c.vid) field(FIELD_VID, c.vid);
    field(FIELD_EOS);
  }
  field(FIELD_EOS); // end of caveats
  field(FIELD_SIGNATURE, m.signature);
  return Uint8Array.from(out);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildCaveats(opts: AttenuateOptions, bounds: ExistingBounds): string[] {
  const out: string[] = [];
  if (opts.method) out.push(`method=${opts.method}`);
  if (opts.validUntil != null) {
    const ms = Math.floor(
      opts.validUntil instanceof Date ? opts.validUntil.getTime() : opts.validUntil,
    );
    if (bounds.validUntilMs !== undefined && ms > bounds.validUntilMs) {
      throw new Error(
        `attenuate(): validUntil ${ms} is later than the credential's existing expiry ${bounds.validUntilMs} (can only tighten)`,
      );
    }
    out.push(`valid_until=${ms}`);
  }
  if (opts.nUses != null) {
    const n = validateCaveatUint(opts.nUses, "nUses");
    if (bounds.nUses !== undefined && n > bounds.nUses) {
      throw new Error(
        `attenuate(): nUses ${n} exceeds the credential's existing n_uses ${bounds.nUses} (can only tighten)`,
      );
    }
    out.push(`n_uses=${n}`);
  }
  if (opts.maxSats != null) {
    const n = validateCaveatUint(opts.maxSats, "maxSats");
    if (bounds.maxSats !== undefined && n > bounds.maxSats) {
      throw new Error(
        `attenuate(): maxSats ${n} exceeds the credential's existing max_sats ${bounds.maxSats} (can only tighten)`,
      );
    }
    out.push(`max_sats=${n}`);
  }
  if (opts.pathPrefix != null) {
    const norm = normalizePathPrefix(opts.pathPrefix); // throws on ../ //, bad encoding, etc.
    if (bounds.pathPrefix !== undefined && !pathMatchesPrefix(norm, bounds.pathPrefix)) {
      throw new Error(
        `attenuate(): pathPrefix ${JSON.stringify(norm)} is not at or under the credential's existing path_prefix ${JSON.stringify(bounds.pathPrefix)} (can only tighten)`,
      );
    }
    out.push(`path_prefix=${norm}`);
  }
  return out;
}

/** Validate an n_uses/max_sats attenuation input: a positive integer within
 * the 2^32-1 caveat ceiling, matching the gateway's parsePositiveCaveatInt. */
function validateCaveatUint(n: number, name: string): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`attenuate(): ${name} must be a positive integer`);
  }
  if (n > 0xffffffff) {
    throw new Error(`attenuate(): ${name} exceeds the 2^32-1 caveat ceiling`);
  }
  return n;
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

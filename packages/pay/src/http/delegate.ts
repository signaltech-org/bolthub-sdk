import { importMacaroon, type Macaroon } from "macaroon";

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
  return bytesToBase64(exportMacaroonBinaryV2(m));
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

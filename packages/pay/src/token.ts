/**
 * L402 token + preimage primitives, wire-compatible with the bolthub gateway
 * (`apps/gateway-go/internal/l402/l402.go`).
 *
 * A token is `base64url(json(payload)) + "." + hex(HMAC_SHA256(secret, "l402:" + encoded))`.
 * The buyer pays the invoice bound to `payload.paymentHash`, then presents
 * `<token>:<preimageHex>`; the seller checks the signature, the expiry, and that
 * `SHA256(preimage) == paymentHash`. All comparisons are constant-time.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Domain-separation prefix for L402 tokens (matches the gateway). */
const DOMAIN_L402 = "l402";

/** Data encoded inside an L402 token. */
export interface L402TokenPayload {
  /** Hex SHA-256 payment hash the buyer's preimage must hash to. */
  paymentHash: string;
  /** Resource the token is scoped to (e.g. a tool name). */
  resource: string;
  /** Expiry, Unix milliseconds. */
  expiresAt: number;
}

/** Result of {@link verifyL402Token}. */
export type VerifyTokenResult =
  | { ok: true; payload: L402TokenPayload }
  | { ok: false; reason: string };

function hmacHex(secret: string, domain: string, data: string): string {
  return createHmac("sha256", secret).update(`${domain}:${data}`).digest("hex");
}

/** Constant-time compare of two equal-length hex strings. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Decode hex to a Buffer, returning null on malformed or wrong-length input. */
function hexToBuf(hex: string, expectedBytes?: number): Buffer | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const buf = Buffer.from(hex, "hex");
  if (expectedBytes !== undefined && buf.length !== expectedBytes) return null;
  return buf;
}

/** Sign a payload into an L402 token. */
export function signL402Token(secret: string, payload: L402TokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmacHex(secret, DOMAIN_L402, encoded)}`;
}

/**
 * Verify an L402 token's signature and expiry. Non-future or missing `expiresAt`
 * is rejected (defence in depth: {@link signL402Token} always stamps one, so a
 * token without it is malformed or tampered).
 *
 * @param now Override the clock (testing). Defaults to `Date.now()`.
 */
export function verifyL402Token(secret: string, token: string, now: number = Date.now()): VerifyTokenResult {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed token" };

  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqualHex(hmacHex(secret, DOMAIN_L402, encoded), sig)) {
    return { ok: false, reason: "bad signature" };
  }

  let payload: L402TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as L402TokenPayload;
  } catch {
    return { ok: false, reason: "undecodable payload" };
  }

  if (!payload || typeof payload.paymentHash !== "string" || !payload.paymentHash || !payload.resource) {
    return { ok: false, reason: "incomplete payload" };
  }
  if (!(typeof payload.expiresAt === "number" && payload.expiresAt > 0)) {
    return { ok: false, reason: "missing expiresAt" };
  }
  if (now > payload.expiresAt) {
    return { ok: false, reason: "token expired" };
  }
  return { ok: true, payload };
}

/**
 * Constant-time check that `SHA256(preimage) == paymentHash`. Both must be
 * 32-byte hex strings. Mirrors the gateway's `VerifyPreimage`.
 */
export function verifyPreimage(preimageHex: string, paymentHashHex: string): boolean {
  const preimage = hexToBuf(preimageHex, 32);
  const expected = hexToBuf(paymentHashHex, 32);
  if (!preimage || !expected) return false;
  const hash = createHash("sha256").update(preimage).digest();
  return timingSafeEqual(hash, expected);
}

/** Hex SHA-256 of a hex-encoded input. Convenience for invoice providers/tests. */
export function sha256Hex(hex: string): string {
  const buf = hexToBuf(hex);
  if (!buf) throw new Error("sha256Hex: input must be non-empty even-length hex");
  return createHash("sha256").update(buf).digest("hex");
}

/** A random 32-byte preimage, hex-encoded. Useful for mock invoice providers and demos. */
export function randomPreimage(): string {
  return randomBytes(32).toString("hex");
}

import { describe, expect, test } from "bun:test";
import {
  randomPreimage,
  sha256Hex,
  signL402Token,
  verifyL402Token,
  verifyPreimage,
} from "../token";

const SECRET = "test-secret-at-least-thirty-two-bytes-long!!";

describe("L402 token", () => {
  test("signs and verifies a round trip", () => {
    const expiresAt = Date.now() + 60_000;
    const token = signL402Token(SECRET, { paymentHash: "ab".repeat(32), resource: "tool_x", expiresAt });
    const res = verifyL402Token(SECRET, token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.resource).toBe("tool_x");
      expect(res.payload.paymentHash).toBe("ab".repeat(32));
    }
  });

  test("rejects a wrong secret", () => {
    const token = signL402Token(SECRET, { paymentHash: "ab".repeat(32), resource: "t", expiresAt: Date.now() + 60_000 });
    const res = verifyL402Token("another-secret-also-thirty-two-bytes-xx!", token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad signature");
  });

  test("rejects a tampered payload", () => {
    const token = signL402Token(SECRET, { paymentHash: "ab".repeat(32), resource: "t", expiresAt: Date.now() + 60_000 });
    const [encoded, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ paymentHash: "cd".repeat(32), resource: "t", expiresAt: Date.now() + 60_000 })).toString("base64url");
    const res = verifyL402Token(SECRET, `${forged}.${sig}`);
    expect(res.ok).toBe(false);
    expect(encoded).not.toBe(forged);
  });

  test("rejects an expired token", () => {
    const token = signL402Token(SECRET, { paymentHash: "ab".repeat(32), resource: "t", expiresAt: 1000 });
    const res = verifyL402Token(SECRET, token, 2000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("token expired");
  });

  test("rejects malformed tokens", () => {
    expect(verifyL402Token(SECRET, "nodot").ok).toBe(false);
    expect(verifyL402Token(SECRET, "trailing.").ok).toBe(false);
    expect(verifyL402Token(SECRET, ".leading").ok).toBe(false);
  });
});

describe("preimage", () => {
  test("accepts a matching preimage", () => {
    const preimage = randomPreimage();
    const hash = sha256Hex(preimage);
    expect(verifyPreimage(preimage, hash)).toBe(true);
  });

  test("rejects a non-matching preimage", () => {
    const hash = sha256Hex(randomPreimage());
    expect(verifyPreimage(randomPreimage(), hash)).toBe(false);
  });

  test("rejects malformed hex and wrong lengths", () => {
    const hash = sha256Hex(randomPreimage());
    expect(verifyPreimage("zz".repeat(32), hash)).toBe(false); // non-hex
    expect(verifyPreimage("ab", hash)).toBe(false); // too short
    expect(verifyPreimage(randomPreimage(), "ab")).toBe(false); // bad hash length
  });
});

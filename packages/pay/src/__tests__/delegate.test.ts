import { describe, test, expect } from "bun:test";
import { attenuate } from "../http/delegate";
import * as macaroon from "macaroon";

// Mint a gateway-shaped macaroon (std-base64 of a libmacaroons v2 binary).
function mint(): string {
  const m = macaroon.newMacaroon({
    version: 2,
    rootKey: new Uint8Array(32),
    identifier: '{"v":1,"kid":"x","tid":"t1"}',
    location: "bolthub",
  });
  m.addFirstPartyCaveat("payment_hash=abc");
  return Buffer.from(m.exportBinary()).toString("base64");
}

function caveatIds(b64: string): string[] {
  const m = macaroon.importMacaroon(Uint8Array.from(Buffer.from(b64, "base64")));
  const json = m.exportJSON() as any;
  const list = json.c ?? json.caveats ?? [];
  return list.map((c: any) => c.i ?? c.cid ?? c.identifier);
}

// A real macaroon as minted by the production Go gateway: header + four binding
// caveats (payment_hash, tenant_id, endpoint_id, expires_at) + signature. The
// `mint()` fixture above has a single caveat, which is too few to trip the bug
// this guards against: the bundled `macaroon` lib's `exportBinary()` over-grows
// its buffer on every append, and only overflows once a macaroon has enough
// fields. Every real L402 token does. (Capture: 402 challenge from btc-intel.)
const GATEWAY_MACAROON =
  "AgEHYm9sdGh1YgJFeyJ2IjoxLCJraWQiOiIwNjZlYTZmNCIsInRpZCI6IjhlNDU5NzMxLTgwYWYtNGI4Mi1hODFkLTYyMjJlYjJjOTEyZSJ9AAJNcGF5bWVudF9oYXNoPTUxYjAxOWZkOWZkMTM5OTk1OWIzYWVkODI1NDlmMGZiYjFjN2E5Zjc5NmM5MGFjOWUwYzFiNmQwMmY2NzgyMjMAAi50ZW5hbnRfaWQ9OGU0NTk3MzEtODBhZi00YjgyLWE4MWQtNjIyMmViMmM5MTJlAAIwZW5kcG9pbnRfaWQ9ZWFjODZjMzYtYTgxOC00ODIyLTg2YzYtNDE0NDc3YTVmYzk2AAIYZXhwaXJlc19hdD0xNzgyNDc5NTgzMzY2AAAGIIBZfBD3S6tz8Gf4+vfShVH2hwfwB8vRR2swa4N3tAXC";

describe("attenuate", () => {
  test("appends method and valid_until caveats, preserving the binding ones", () => {
    const out = attenuate(mint(), { method: "GET", validUntil: 9999999999999 });
    const ids = caveatIds(out);
    expect(ids).toContain("method=GET");
    expect(ids).toContain("valid_until=9999999999999");
    expect(ids).toContain("payment_hash=abc");
  });

  test("accepts a Date for validUntil", () => {
    const d = new Date("2030-01-01T00:00:00Z");
    const out = attenuate(mint(), { validUntil: d });
    expect(caveatIds(out)).toContain(`valid_until=${d.getTime()}`);
  });

  test("requires at least one restriction", () => {
    expect(() => attenuate(mint(), {})).toThrow();
  });

  test("output is standard base64", () => {
    const out = attenuate(mint(), { method: "GET" });
    expect(() => atob(out)).not.toThrow();
  });

  // --- Caveat schema v2 (AF-D3): n_uses / max_sats / path_prefix ---

  // Mint a macaroon that already carries v2 caveats, to test tighten-only folds.
  function mintWith(...caveats: string[]): string {
    const m = macaroon.newMacaroon({
      version: 2,
      rootKey: new Uint8Array(32),
      identifier: '{"v":1,"kid":"x","tid":"t1"}',
      location: "bolthub",
    });
    m.addFirstPartyCaveat("payment_hash=abc");
    for (const c of caveats) m.addFirstPartyCaveat(c);
    return Buffer.from(m.exportBinary()).toString("base64");
  }

  test("appends n_uses, max_sats, and a normalized path_prefix", () => {
    const out = attenuate(mint(), { nUses: 50, maxSats: 300, pathPrefix: "/v1/user/" });
    const ids = caveatIds(out);
    expect(ids).toContain("n_uses=50");
    expect(ids).toContain("max_sats=300");
    expect(ids).toContain("path_prefix=/v1/user"); // trailing slash normalized away
  });

  test("n_uses may only tighten (== ok, lower ok, higher throws)", () => {
    expect(caveatIds(attenuate(mintWith("n_uses=100"), { nUses: 100 }))).toContain("n_uses=100");
    expect(caveatIds(attenuate(mintWith("n_uses=100"), { nUses: 10 }))).toContain("n_uses=10");
    expect(() => attenuate(mintWith("n_uses=100"), { nUses: 101 })).toThrow(/can only tighten/);
  });

  test("max_sats may only tighten", () => {
    expect(caveatIds(attenuate(mintWith("max_sats=500"), { maxSats: 500 }))).toContain("max_sats=500");
    expect(() => attenuate(mintWith("max_sats=500"), { maxSats: 501 })).toThrow(/can only tighten/);
  });

  test("path_prefix may only narrow: a child under the parent is ok, a sibling/parent is refused", () => {
    // Under the parent prefix: allowed.
    expect(caveatIds(attenuate(mintWith("path_prefix=/v1/user"), { pathPrefix: "/v1/user/42" }))).toContain(
      "path_prefix=/v1/user/42",
    );
    // Exactly the parent: allowed (== is a tighten no-op).
    expect(caveatIds(attenuate(mintWith("path_prefix=/v1/user"), { pathPrefix: "/v1/user" }))).toContain(
      "path_prefix=/v1/user",
    );
    // A sibling path is not under the parent: refused.
    expect(() => attenuate(mintWith("path_prefix=/v1/user"), { pathPrefix: "/v1/admin" })).toThrow(
      /can only tighten/,
    );
    // Widening back to the root is refused (segment boundary: /v1/userdata is NOT under /v1/user either).
    expect(() => attenuate(mintWith("path_prefix=/v1/user"), { pathPrefix: "/v1" })).toThrow(/can only tighten/);
    expect(() => attenuate(mintWith("path_prefix=/v1/user"), { pathPrefix: "/v1/userdata" })).toThrow(
      /can only tighten/,
    );
  });

  test("validUntil may only move earlier", () => {
    expect(caveatIds(attenuate(mintWith("valid_until=2000"), { validUntil: 1500 }))).toContain("valid_until=1500");
    expect(() => attenuate(mintWith("valid_until=2000"), { validUntil: 2001 })).toThrow(/can only tighten/);
  });

  test("path_prefix normalization rejects traversal and interior //", () => {
    expect(() => attenuate(mint(), { pathPrefix: "/v1/../admin" })).toThrow();
    expect(() => attenuate(mint(), { pathPrefix: "/v1//user" })).toThrow();
    expect(() => attenuate(mint(), { pathPrefix: "no-leading-slash" })).toThrow();
  });

  test("n_uses / max_sats reject non-positive, non-integer, and over-ceiling values", () => {
    for (const bad of [0, -5, 1.5, 0x1_0000_0000]) {
      expect(() => attenuate(mint(), { nUses: bad })).toThrow();
      expect(() => attenuate(mint(), { maxSats: bad })).toThrow();
    }
  });

  test("v2 caveats compose with method in one call", () => {
    const ids = caveatIds(attenuate(mint(), { method: "GET", nUses: 5, pathPrefix: "/v1/data" }));
    expect(ids).toContain("method=GET");
    expect(ids).toContain("n_uses=5");
    expect(ids).toContain("path_prefix=/v1/data");
  });

  // Regression: a real gateway macaroon (4 binding caveats) used to throw
  // `RangeError: length too large` inside the bundled lib's exportBinary().
  test("attenuates a real 4-caveat gateway macaroon and preserves every caveat", () => {
    const out = attenuate(GATEWAY_MACAROON, {
      method: "GET",
      validUntil: 9999999999999,
    });
    const ids = caveatIds(out);
    // the four binding caveats survive (append-only)...
    for (const prefix of ["payment_hash=", "tenant_id=", "endpoint_id=", "expires_at="]) {
      expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    }
    // ...and our two restrictions are appended
    expect(ids).toContain("method=GET");
    expect(ids).toContain("valid_until=9999999999999");
    expect(ids).toHaveLength(6);
    // and the result re-parses as a valid v2 binary macaroon
    expect(() =>
      macaroon.importMacaroon(Uint8Array.from(Buffer.from(out, "base64"))),
    ).not.toThrow();
  });
});

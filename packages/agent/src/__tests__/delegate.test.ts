import { describe, test, expect } from "bun:test";
import { attenuate } from "../delegate";
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
});

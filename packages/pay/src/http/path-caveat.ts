/**
 * Caveat schema v2 path/int helpers — the TS side of the cross-language
 * contract (agent-features AF-G5). A byte-for-byte port of the Go gateway
 * verifier (apps/gateway-go/internal/l402/pathcaveat.go) so a token the SDK
 * attenuates with a `path_prefix` (AF-D3) is judged the same by the gateway.
 * The shared vectors in caveat_vectors.json pin the two implementations.
 * Spec: docs/design/agent-features/DESIGN.md §3.
 */

/** Normalize a `path_prefix` CAVEAT value; throws on a rejected input. */
export function normalizePathPrefix(p: string): string {
  return normalizePathCore(p, true);
}

/** Normalize an incoming request path; throws on a rejected input. */
export function normalizeRequestPath(p: string): string {
  return normalizePathCore(p, false);
}

function normalizePathCore(p: string, isCaveat: boolean): string {
  if (p === "") throw new Error("empty path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(p); // single decode; matches Go url.PathUnescape
  } catch {
    throw new Error("bad percent-encoding in path");
  }
  if (!decoded.startsWith("/")) throw new Error("path must start with /");
  if (decoded.includes("://") || decoded.startsWith("//")) {
    throw new Error("path must not contain scheme or authority");
  }
  if (decoded.includes("\\")) throw new Error("path must not contain backslash");

  // A caveat rejects an INTERIOR `//`; a single trailing slash is fine (it is
  // canonicalized away). Match Go: trim ONE trailing slash, then check `//`.
  if (isCaveat) {
    let trimmed = decoded;
    if (trimmed !== "/" && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
    if (trimmed.includes("//")) throw new Error("path_prefix must not contain an interior // segment");
  }

  const out: string[] = [];
  for (const s of decoded.split("/").slice(1)) {
    if (s === "..") throw new Error("path must not contain a .. segment");
    if (s === "." || s === "") continue;
    out.push(s);
  }
  return "/" + out.join("/");
}

/**
 * Segment-boundary prefix match on already-normalized inputs. `/v1/user`
 * matches `/v1/user` and `/v1/user/42` but not `/v1/userdata`; `/` matches
 * everything. Case-SENSITIVE.
 */
export function pathMatchesPrefix(reqPath: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (reqPath === prefix) return true;
  return reqPath.startsWith(prefix + "/");
}

/**
 * Parse an `n_uses` / `max_sats` caveat value: digits only, strictly
 * positive, bounded at 2^32-1. Throws on anything else. Matches Go
 * parsePositiveCaveatInt.
 */
export function parseCaveatInt(val: string): number {
  if (!/^[0-9]+$/.test(val)) throw new Error(`value ${JSON.stringify(val)} is not a plain non-negative integer`);
  const n = Number(val);
  if (n === 0) throw new Error("value must be positive");
  if (n > 0xffffffff) throw new Error("value exceeds the 2^32-1 caveat ceiling");
  return n;
}

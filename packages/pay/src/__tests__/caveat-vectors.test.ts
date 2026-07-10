import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePathPrefix,
  normalizeRequestPath,
  pathMatchesPrefix,
  parseCaveatInt,
} from "../http/path-caveat";

// The shared caveat-vector fixture is the single source of truth across the Go
// gateway verifier, this SDK, and the Python SDK (same convention as
// tpp_vectors.json). If any of the three drifts, its run of these vectors
// fails.
const vectors = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../agent-python/tests/fixtures/caveat_vectors.json"),
    "utf-8",
  ),
) as {
  normalize_prefix: { in: string; out?: string; reject?: boolean }[];
  normalize_request: { in: string; out?: string; reject?: boolean }[];
  match: { prefix: string; path: string; match: boolean }[];
  parse_int: { in: string; value?: number; reject?: boolean }[];
};

describe("caveat vectors (cross-language, TS side)", () => {
  test("normalize_prefix", () => {
    for (const c of vectors.normalize_prefix) {
      if (c.reject) {
        expect(() => normalizePathPrefix(c.in), `expected reject for ${JSON.stringify(c.in)}`).toThrow();
      } else {
        expect(normalizePathPrefix(c.in), `for ${JSON.stringify(c.in)}`).toBe(c.out!);
      }
    }
  });

  test("normalize_request", () => {
    for (const c of vectors.normalize_request) {
      if (c.reject) {
        expect(() => normalizeRequestPath(c.in), `expected reject for ${JSON.stringify(c.in)}`).toThrow();
      } else {
        expect(normalizeRequestPath(c.in), `for ${JSON.stringify(c.in)}`).toBe(c.out!);
      }
    }
  });

  test("match", () => {
    for (const c of vectors.match) {
      expect(pathMatchesPrefix(c.path, c.prefix), `prefix=${c.prefix} path=${c.path}`).toBe(c.match);
    }
  });

  test("parse_int", () => {
    for (const c of vectors.parse_int) {
      if (c.reject) {
        expect(() => parseCaveatInt(c.in), `expected reject for ${JSON.stringify(c.in)}`).toThrow();
      } else {
        expect(parseCaveatInt(c.in), `for ${JSON.stringify(c.in)}`).toBe(c.value!);
      }
    }
  });
});

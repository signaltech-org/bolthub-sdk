import { describe, test, expect, afterEach } from "bun:test";
import { FileSessionStore } from "../session-store";
import type { SessionData } from "../session-store";
import { mkdirSync, existsSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

function tmpFile(): string {
  const dir = join(tmpdir(), `bolthub-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "sessions.json");
}

const tempFiles: string[] = [];

afterEach(() => {
  for (const f of tempFiles) {
    try {
      const dir = join(f, "..");
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  tempFiles.length = 0;
});

describe("FileSessionStore", () => {
  test("stores and retrieves a session", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store = new FileSessionStore(path);
    const session: SessionData = {
      token: "tok1",
      expiresAt: Date.now() + 60_000,
      balance: 5,
    };

    store.set("host/path", session);
    const got = store.get("host/path");

    expect(got).toBeDefined();
    expect(got!.token).toBe("tok1");
    expect(got!.balance).toBe(5);
  });

  test("returns undefined for missing keys", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store = new FileSessionStore(path);
    expect(store.get("no-such-key")).toBeUndefined();
  });

  test("returns undefined and prunes expired sessions", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store = new FileSessionStore(path);
    store.set("expired", {
      token: "old",
      expiresAt: Date.now() - 1000,
    });

    expect(store.get("expired")).toBeUndefined();
  });

  test("delete removes a session", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store = new FileSessionStore(path);
    store.set("k", { token: "t", expiresAt: Date.now() + 60_000 });
    store.delete("k");

    expect(store.get("k")).toBeUndefined();
  });

  test("clear removes all sessions", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store = new FileSessionStore(path);
    store.set("a", { token: "t1", expiresAt: Date.now() + 60_000 });
    store.set("b", { token: "t2", expiresAt: Date.now() + 60_000 });
    store.clear();

    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeUndefined();
  });

  test("persists to disk and reloads on construction", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store1 = new FileSessionStore(path);
    store1.set("persisted", {
      token: "disk",
      expiresAt: Date.now() + 60_000,
    });

    const store2 = new FileSessionStore(path);
    const got = store2.get("persisted");

    expect(got).toBeDefined();
    expect(got!.token).toBe("disk");
  });

  test("prunes expired sessions on load", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store1 = new FileSessionStore(path);
    store1.set("fresh", { token: "a", expiresAt: Date.now() + 60_000 });
    store1.set("stale", { token: "b", expiresAt: Date.now() - 1000 });

    const store2 = new FileSessionStore(path);
    expect(store2.get("fresh")).toBeDefined();
    expect(store2.get("stale")).toBeUndefined();
  });

  test("entries() iterates all live sessions", () => {
    const path = tmpFile();
    tempFiles.push(path);

    const store = new FileSessionStore(path);
    store.set("x", { token: "t1", expiresAt: Date.now() + 60_000 });
    store.set("y", { token: "t2", expiresAt: Date.now() + 60_000 });

    const keys = [...store.entries()].map(([k]) => k).sort();
    expect(keys).toEqual(["x", "y"]);
  });

  test("creates file in non-existent directory", () => {
    const dir = join(tmpdir(), `bolthub-deep-${randomBytes(4).toString("hex")}`, "sub");
    const path = join(dir, "sessions.json");
    tempFiles.push(path);

    const store = new FileSessionStore(path);
    store.set("k", { token: "t", expiresAt: Date.now() + 60_000 });

    expect(existsSync(path)).toBe(true);
  });
});

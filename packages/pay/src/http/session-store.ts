/// <reference types="node" />
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

/** A single cached session returned by the gateway after a successful L402 payment. */
export interface SessionData {
  /** Opaque token sent back to the gateway via `X-Session-Token`. */
  token: string;
  /** Unix-millisecond timestamp after which the session is considered expired. */
  expiresAt: number;
  /** Remaining request balance on this session, if the gateway reports one. */
  balance?: number;
}

/**
 * Pluggable storage backend for gateway session tokens.
 *
 * The default in-memory store is suitable for short-lived scripts.
 * Use {@link FileSessionStore} for CLI tools or long-running agents that
 * should survive restarts.
 */
export interface SessionStore {
  get(key: string): SessionData | undefined;
  set(key: string, session: SessionData): void;
  delete(key: string): void;
  clear(): void;
  entries(): IterableIterator<[string, SessionData]>;
}

interface StoreFile {
  v: 1;
  sessions: Record<string, SessionData>;
}

const DEFAULT_DIR = join(homedir(), ".bolthub");
const DEFAULT_FILE = "sessions.json";

/**
 * Persists session tokens to a JSON file on disk (`~/.bolthub/sessions.json`
 * by default). Writes are atomic (rename-over) and the file is
 * created with `0600` permissions.
 */
export class FileSessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();
  private filePath: string;

  /** @param filePath - Custom path to the session file. Defaults to `~/.bolthub/sessions.json`. */
  constructor(filePath?: string) {
    this.filePath = filePath ?? join(DEFAULT_DIR, DEFAULT_FILE);
    this.load();
  }

  get(key: string): SessionData | undefined {
    const session = this.sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      this.persist();
      return undefined;
    }
    return session;
  }

  set(key: string, session: SessionData): void {
    this.sessions.set(key, session);
    this.persist();
  }

  delete(key: string): void {
    if (this.sessions.delete(key)) {
      this.persist();
    }
  }

  clear(): void {
    this.sessions.clear();
    this.persist();
  }

  entries(): IterableIterator<[string, SessionData]> {
    return this.sessions.entries();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data: StoreFile = JSON.parse(raw);
      if (data.v !== 1 || !data.sessions) return;

      const now = Date.now();
      let pruned = false;
      for (const [key, session] of Object.entries(data.sessions)) {
        if (session.expiresAt > now && session.token) {
          this.sessions.set(key, session);
        } else {
          pruned = true;
        }
      }
      if (pruned) this.persist();
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Directory already exists
    }

    const data: StoreFile = {
      v: 1,
      sessions: Object.fromEntries(this.sessions),
    };

    const tmp = join(dir, `.sessions-${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      // Clean up the temp file, then surface the failure instead of silently
      // swallowing it — otherwise set/delete/clear report success on a failed
      // write and the caller loses data without knowing.
      try { unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
      throw err;
    }
  }
}

import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  verifyGatewaySignature,
  verifyGatewaySecret,
  expressHmacMiddleware,
  expressSecretMiddleware,
} from "../index";
import type { RequestLike } from "../index";

const SECRET = "test-secret-key-32chars-long!!!!";

function computeHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function makeSignedRequest(overrides: Partial<{
  method: string;
  path: string;
  body: string;
  secret: string;
  timestamp: string;
  nonce: string;
}> = {}): RequestLike {
  const method = overrides.method ?? "GET";
  const path = overrides.path ?? "/api/data";
  const body = overrides.body ?? "";
  const secret = overrides.secret ?? SECRET;
  const timestamp = overrides.timestamp ?? String(Date.now());
  const nonce = overrides.nonce ?? "random-nonce-123";

  const payload = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}`;
  const signature = computeHmac(secret, payload);

  return {
    method,
    path,
    body,
    headers: {
      "X-Gateway-Signature": signature,
      "X-Gateway-Timestamp": timestamp,
      "X-Gateway-Nonce": nonce,
    },
  };
}

describe("verifyGatewaySignature", () => {
  test("accepts a valid signature", () => {
    const req = makeSignedRequest();
    const result = verifyGatewaySignature(req, { secrets: SECRET });
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("accepts valid signature with Headers object", () => {
    const method = "POST";
    const path = "/api/submit";
    const body = '{"key":"value"}';
    const timestamp = String(Date.now());
    const nonce = "nonce-456";
    const payload = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}`;
    const signature = computeHmac(SECRET, payload);

    const headers = new Headers();
    headers.set("X-Gateway-Signature", signature);
    headers.set("X-Gateway-Timestamp", timestamp);
    headers.set("X-Gateway-Nonce", nonce);

    const result = verifyGatewaySignature(
      { method, path, body, headers },
      { secrets: SECRET },
    );
    expect(result.valid).toBe(true);
  });

  test("rejects missing signature headers", () => {
    const result = verifyGatewaySignature(
      { method: "GET", path: "/", headers: {} },
      { secrets: SECRET },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  test("rejects expired timestamp", () => {
    const req = makeSignedRequest({
      timestamp: String(Date.now() - 60_000),
    });
    const result = verifyGatewaySignature(req, { secrets: SECRET, maxAgeMs: 30_000 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  test("rejects future timestamp (clock skew)", () => {
    const req = makeSignedRequest({
      timestamp: String(Date.now() + 60_000),
    });
    const result = verifyGatewaySignature(req, { secrets: SECRET });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("clock skew");
  });

  test("rejects invalid signature", () => {
    const req = makeSignedRequest();
    (req.headers as Record<string, string>)["X-Gateway-Signature"] = "deadbeef";
    const result = verifyGatewaySignature(req, { secrets: SECRET });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid");
  });

  test("supports secret rotation with array", () => {
    const oldSecret = "old-secret-key-32chars-long!!!!!";
    const req = makeSignedRequest({ secret: oldSecret });
    const result = verifyGatewaySignature(req, { secrets: [SECRET, oldSecret] });
    expect(result.valid).toBe(true);
  });

  test("rejects when no secret matches", () => {
    const req = makeSignedRequest({ secret: "wrong-secret-key-32chars-long!!!" });
    const result = verifyGatewaySignature(req, { secrets: [SECRET] });
    expect(result.valid).toBe(false);
  });

  test("handles empty body", () => {
    const req = makeSignedRequest({ body: "" });
    const result = verifyGatewaySignature(req, { secrets: SECRET });
    expect(result.valid).toBe(true);
  });

  test("custom maxAgeMs is respected", () => {
    const req = makeSignedRequest({
      timestamp: String(Date.now() - 5_000),
    });
    const tight = verifyGatewaySignature(req, { secrets: SECRET, maxAgeMs: 1_000 });
    expect(tight.valid).toBe(false);

    const loose = verifyGatewaySignature(req, { secrets: SECRET, maxAgeMs: 10_000 });
    expect(loose.valid).toBe(true);
  });
});

describe("verifyGatewaySecret", () => {
  test("accepts valid secret", () => {
    const result = verifyGatewaySecret(
      { method: "GET", path: "/", headers: { "X-Gateway-Secret": SECRET } },
      { secrets: SECRET },
    );
    expect(result.valid).toBe(true);
  });

  test("rejects missing header", () => {
    const result = verifyGatewaySecret(
      { method: "GET", path: "/", headers: {} },
      { secrets: SECRET },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  test("rejects wrong secret", () => {
    const result = verifyGatewaySecret(
      { method: "GET", path: "/", headers: { "X-Gateway-Secret": "wrong" } },
      { secrets: SECRET },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid");
  });

  test("supports rotation with array", () => {
    const oldSecret = "old-secret";
    const result = verifyGatewaySecret(
      { method: "GET", path: "/", headers: { "X-Gateway-Secret": oldSecret } },
      { secrets: [SECRET, oldSecret] },
    );
    expect(result.valid).toBe(true);
  });

  test("works with Headers object", () => {
    const headers = new Headers();
    headers.set("X-Gateway-Secret", SECRET);
    const result = verifyGatewaySecret(
      { method: "GET", path: "/", headers },
      { secrets: SECRET },
    );
    expect(result.valid).toBe(true);
  });
});

describe("expressHmacMiddleware", () => {
  test("calls next() on valid signature", () => {
    const middleware = expressHmacMiddleware({ secrets: SECRET });

    const timestamp = String(Date.now());
    const nonce = "nonce-mw";
    const body = '{"key":"val"}';
    const payload = `POST\n/api/data\n${timestamp}\n${nonce}\n${body}`;
    const signature = computeHmac(SECRET, payload);

    const req = {
      method: "POST",
      path: "/api/data",
      headers: {
        "X-Gateway-Signature": signature,
        "X-Gateway-Timestamp": timestamp,
        "X-Gateway-Nonce": nonce,
      },
      body: { key: "val" },
    };

    let nextCalled = false;
    const res = { status: () => res, json: () => {} } as any;
    const next = () => { nextCalled = true; };

    middleware(req as any, res, next);
    expect(nextCalled).toBe(true);
  });

  test("rejects with 403 on missing signature", () => {
    const middleware = expressHmacMiddleware({ secrets: SECRET });

    const req = { method: "GET", path: "/", headers: {} };
    let statusCode = 0;
    let responseBody: any = null;
    const res = {
      status(code: number) { statusCode = code; return res; },
      json(body: unknown) { responseBody = body; },
    } as any;
    const next = () => {};

    middleware(req as any, res, next);
    expect(statusCode).toBe(403);
    expect(responseBody?.error).toBeDefined();
  });
});

describe("expressSecretMiddleware", () => {
  test("calls next() on valid secret", () => {
    const middleware = expressSecretMiddleware({ secrets: SECRET });

    const req = { method: "GET", path: "/", headers: { "X-Gateway-Secret": SECRET } };
    let nextCalled = false;
    const res = { status: () => res, json: () => {} } as any;
    const next = () => { nextCalled = true; };

    middleware(req as any, res, next);
    expect(nextCalled).toBe(true);
  });

  test("rejects with 403 on invalid secret", () => {
    const middleware = expressSecretMiddleware({ secrets: SECRET });

    const req = { method: "GET", path: "/", headers: { "X-Gateway-Secret": "wrong" } };
    let statusCode = 0;
    const res = {
      status(code: number) { statusCode = code; return res; },
      json() {},
    } as any;
    const next = () => {};

    middleware(req as any, res, next);
    expect(statusCode).toBe(403);
  });
});

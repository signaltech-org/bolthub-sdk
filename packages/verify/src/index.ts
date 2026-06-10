import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyOptions {
  /**
   * Your HMAC secret from the bolthub dashboard (Settings > Secrets).
   * Pass an array of secrets to support rotation (current + previous).
   */
  secrets: string | string[];

  /**
   * Maximum age of a request signature in milliseconds before it's
   * considered stale. Defaults to 30000 (30 seconds).
   */
  maxAgeMs?: number;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
}

export interface RequestLike {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined> | Headers;
  body?: string;
}

function getHeader(headers: RequestLike["headers"], name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const val = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

function computeHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Verify that a request was proxied through the bolthub gateway
 * by checking the X-Gateway-Signature HMAC-SHA256 header.
 *
 * The signature covers the canonical payload:
 * `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY`
 */
export function verifyGatewaySignature(
  request: RequestLike,
  options: VerifyOptions,
): VerifyResult {
  const signature = getHeader(request.headers, "X-Gateway-Signature");
  const timestamp = getHeader(request.headers, "X-Gateway-Timestamp");
  const nonce = getHeader(request.headers, "X-Gateway-Nonce");

  if (!signature || !timestamp || !nonce) {
    return { valid: false, error: "Missing gateway signature headers" };
  }

  const maxAge = options.maxAgeMs ?? 30_000;
  const ageMs = Date.now() - Number(timestamp);
  if (Number.isNaN(ageMs) || ageMs > maxAge || ageMs < 0) {
    return { valid: false, error: "Request signature expired or clock skew detected" };
  }

  const body = request.body ?? "";
  const payload = `${request.method}\n${request.path}\n${timestamp}\n${nonce}\n${body}`;

  const secrets = Array.isArray(options.secrets) ? options.secrets : [options.secrets];

  for (const secret of secrets) {
    if (!secret) continue;
    const expected = computeHmac(secret, payload);
    if (safeCompare(expected, signature)) {
      return { valid: true };
    }
  }

  return { valid: false, error: "Invalid gateway signature" };
}

/**
 * Verify a request using the simpler X-Gateway-Secret shared secret header.
 */
export function verifyGatewaySecret(
  request: RequestLike,
  options: { secrets: string | string[] },
): VerifyResult {
  const header = getHeader(request.headers, "X-Gateway-Secret");
  if (!header) {
    return { valid: false, error: "Missing X-Gateway-Secret header" };
  }

  const secrets = Array.isArray(options.secrets) ? options.secrets : [options.secrets];

  for (const secret of secrets) {
    if (!secret) continue;
    if (safeCompare(secret, header)) {
      return { valid: true };
    }
  }

  return { valid: false, error: "Invalid gateway secret" };
}

// ---------------------------------------------------------------------------
// Express / Connect middleware helpers
// ---------------------------------------------------------------------------

type NextFn = (err?: unknown) => void;
interface ExpressRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
}
interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
}

/**
 * Express/Connect middleware that rejects requests without a valid
 * bolthub gateway HMAC signature. Uses `req.rawBody` if available,
 * otherwise `req.body` stringified.
 */
export function expressHmacMiddleware(options: VerifyOptions) {
  return (req: ExpressRequest, res: ExpressResponse, next: NextFn) => {
    const body = req.rawBody
      ? req.rawBody.toString("utf-8")
      : typeof req.body === "string"
        ? req.body
        : req.body != null
          ? JSON.stringify(req.body)
          : "";

    const result = verifyGatewaySignature(
      { method: req.method, path: req.path, headers: req.headers, body },
      options,
    );

    if (!result.valid) {
      return res.status(403).json({ error: result.error });
    }
    next();
  };
}

/**
 * Express/Connect middleware that rejects requests without a valid
 * X-Gateway-Secret header.
 */
export function expressSecretMiddleware(options: { secrets: string | string[] }) {
  return (req: ExpressRequest, res: ExpressResponse, next: NextFn) => {
    const result = verifyGatewaySecret(
      { method: req.method, path: req.path, headers: req.headers },
      options,
    );

    if (!result.valid) {
      return res.status(403).json({ error: result.error });
    }
    next();
  };
}

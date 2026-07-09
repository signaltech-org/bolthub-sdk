/**
 * Webhook signature verification for bolthub tenant webhooks.
 *
 * The platform signs every delivery with HMAC-SHA256 over
 * `${timestamp}.${rawBody}` (timestamp = `X-Webhook-Timestamp`, milliseconds
 * since epoch) and sends the hex digest in `X-Webhook-Signature`. See
 * apps/api `webhook.service.ts` for the signer; this module is its verifying
 * mirror and must stay wire-compatible with it.
 *
 * Node-only (uses `node:crypto`); intentionally not exported from the
 * browser entry — webhook verification runs on servers.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Event types the platform delivers, plus `"*"` on the subscription side. */
export type WebhookEventType =
  | "invoice.settled"
  | "session.created"
  | "session.expired"
  | "billing.cycle_closed"
  | "billing.payment_received"
  | "billing.suspended"
  | "endpoint.health_changed";

/**
 * The delivery envelope: what `verifyWebhook` returns after the signature
 * checks out. `data` is event-specific; pass a type parameter to narrow it.
 */
export interface WebhookEvent<TData = Record<string, unknown>> {
  /** Unique delivery id, also sent as `X-Webhook-Id`. Retries reuse it — dedupe on this. */
  id: string;
  /** Event type, also sent as `X-Webhook-Event`. */
  event: WebhookEventType;
  /** ISO 8601 time the payload was signed. */
  timestamp: string;
  /** Event-specific payload. */
  data: TData;
}

export type WebhookErrorCode =
  | "missing_secret"
  | "missing_signature"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "invalid_signature_format"
  | "signature_mismatch"
  | "invalid_payload_json";

/** Thrown by {@link verifyWebhook}; `code` says exactly which check failed. */
export class WebhookVerificationError extends Error {
  constructor(
    public readonly code: WebhookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface VerifyWebhookOptions {
  /** The subscription secret returned once when the webhook was created. */
  secret: string;
  /**
   * RAW request body, byte-for-byte as received. If your framework parses
   * JSON before your handler runs, re-serialized bytes will not match the
   * signature — capture the raw body (e.g. `express.raw()`, Nest's
   * `rawBody: true`, or `await request.text()` on fetch-style servers).
   */
  payload: string | Uint8Array;
  /** `X-Webhook-Signature` header value (hex HMAC-SHA256). */
  signature: string;
  /** `X-Webhook-Timestamp` header value (milliseconds since epoch). */
  timestamp: string | number;
  /**
   * Max allowed clock skew between the delivery timestamp and now, for
   * replay protection. Default 5 minutes. Pass `Infinity` to disable
   * (e.g. when verifying stored deliveries after the fact).
   */
  toleranceMs?: number;
  /** Clock injection for tests; must return milliseconds since epoch. */
  now?: () => number;
}

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;
const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Verifies a bolthub webhook delivery and returns the parsed event.
 *
 * Checks, in order: inputs present, timestamp numeric and within
 * `toleranceMs` of now, signature well-formed hex of the right length,
 * HMAC matches (constant-time compare), body parses as JSON. Every failure
 * throws {@link WebhookVerificationError} with a distinct `code`.
 */
export function verifyWebhook<TData = Record<string, unknown>>(
  options: VerifyWebhookOptions,
): WebhookEvent<TData> {
  const {
    secret,
    payload,
    signature,
    timestamp,
    toleranceMs = DEFAULT_TOLERANCE_MS,
    now = Date.now,
  } = options;

  if (!secret) {
    throw new WebhookVerificationError("missing_secret", "secret is required");
  }
  if (!signature) {
    throw new WebhookVerificationError("missing_signature", "signature is required");
  }
  if (timestamp === undefined || timestamp === null || timestamp === "") {
    throw new WebhookVerificationError("missing_timestamp", "timestamp is required");
  }

  const timestampStr = String(timestamp);
  const timestampMs = Number(timestampStr);
  if (!Number.isFinite(timestampMs)) {
    throw new WebhookVerificationError(
      "invalid_timestamp",
      `timestamp is not a number: ${timestampStr}`,
    );
  }

  if (Number.isFinite(toleranceMs)) {
    const skewMs = Math.abs(now() - timestampMs);
    if (skewMs > toleranceMs) {
      throw new WebhookVerificationError(
        "timestamp_out_of_tolerance",
        `timestamp skew ${skewMs}ms exceeds tolerance ${toleranceMs}ms`,
      );
    }
  }

  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestampStr}.`, "utf8"), body]))
    .digest();

  // Buffer.from(sig, "hex") silently truncates at the first invalid char, so
  // validate the format explicitly instead of relying on it to throw.
  if (!HEX_RE.test(signature) || signature.length !== expected.length * 2) {
    throw new WebhookVerificationError(
      "invalid_signature_format",
      "signature is not hex of the expected length",
    );
  }
  if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) {
    throw new WebhookVerificationError(
      "signature_mismatch",
      "signature does not match expected HMAC; check the secret and that the payload is the raw body",
    );
  }

  const bodyString = body.toString("utf8");
  try {
    return JSON.parse(bodyString) as WebhookEvent<TData>;
  } catch (err) {
    throw new WebhookVerificationError(
      "invalid_payload_json",
      `payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

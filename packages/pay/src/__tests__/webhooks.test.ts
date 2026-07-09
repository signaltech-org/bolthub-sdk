/**
 * verifyWebhook — wire-compat with the platform signer (apps/api
 * webhook.service.ts): HMAC-SHA256 over `${timestampMs}.${rawBody}`, hex
 * digest, ms timestamps. Every error path pins its `code`.
 */

import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyWebhook, WebhookVerificationError } from "../webhooks";

const SECRET = "whsec_test_1234567890";
const NOW_MS = 1_752_000_000_000;

/** Sign exactly like the platform does (deliverWebhook in webhook.service.ts). */
function sign(secret: string, timestampMs: number | string, body: string): string {
  return createHmac("sha256", secret).update(`${timestampMs}.${body}`).digest("hex");
}

function makeDelivery(overrides: Partial<Record<string, unknown>> = {}) {
  const envelope = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    event: "invoice.settled",
    timestamp: new Date(NOW_MS).toISOString(),
    data: { invoiceId: "inv_1", amountSats: 21 },
    ...overrides,
  };
  const body = JSON.stringify(envelope);
  return { body, timestamp: String(NOW_MS), signature: sign(SECRET, NOW_MS, body) };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WebhookVerificationError);
    return (err as WebhookVerificationError).code;
  }
  throw new Error("expected verifyWebhook to throw");
}

describe("verifyWebhook", () => {
  test("verifies a platform-signed delivery and returns the parsed event", () => {
    const { body, timestamp, signature } = makeDelivery();
    const event = verifyWebhook({
      secret: SECRET,
      payload: body,
      signature,
      timestamp,
      now: () => NOW_MS,
    });
    expect(event.event).toBe("invoice.settled");
    expect(event.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(event.data).toEqual({ invoiceId: "inv_1", amountSats: 21 });
  });

  test("accepts the raw body as bytes (Buffer/Uint8Array)", () => {
    const { body, timestamp, signature } = makeDelivery();
    const event = verifyWebhook({
      secret: SECRET,
      payload: new TextEncoder().encode(body),
      signature,
      timestamp,
      now: () => NOW_MS,
    });
    expect(event.event).toBe("invoice.settled");
  });

  test("accepts an uppercase hex signature", () => {
    const { body, timestamp, signature } = makeDelivery();
    const event = verifyWebhook({
      secret: SECRET,
      payload: body,
      signature: signature.toUpperCase(),
      timestamp,
      now: () => NOW_MS,
    });
    expect(event.event).toBe("invoice.settled");
  });

  test("narrows data via the type parameter", () => {
    const { body, timestamp, signature } = makeDelivery();
    const event = verifyWebhook<{ invoiceId: string; amountSats: number }>({
      secret: SECRET,
      payload: body,
      signature,
      timestamp,
      now: () => NOW_MS,
    });
    expect(event.data.amountSats).toBe(21);
  });

  test("missing_secret", () => {
    const { body, timestamp, signature } = makeDelivery();
    expect(
      codeOf(() => verifyWebhook({ secret: "", payload: body, signature, timestamp })),
    ).toBe("missing_secret");
  });

  test("missing_signature", () => {
    const { body, timestamp } = makeDelivery();
    expect(
      codeOf(() => verifyWebhook({ secret: SECRET, payload: body, signature: "", timestamp })),
    ).toBe("missing_signature");
  });

  test("missing_timestamp", () => {
    const { body, signature } = makeDelivery();
    expect(
      codeOf(() => verifyWebhook({ secret: SECRET, payload: body, signature, timestamp: "" })),
    ).toBe("missing_timestamp");
  });

  test("invalid_timestamp for a non-numeric value", () => {
    const { body, signature } = makeDelivery();
    expect(
      codeOf(() =>
        verifyWebhook({ secret: SECRET, payload: body, signature, timestamp: "not-a-number" }),
      ),
    ).toBe("invalid_timestamp");
  });

  test("timestamp_out_of_tolerance uses millisecond skew", () => {
    const { body, timestamp, signature } = makeDelivery();
    expect(
      codeOf(() =>
        verifyWebhook({
          secret: SECRET,
          payload: body,
          signature,
          timestamp,
          toleranceMs: 60_000,
          now: () => NOW_MS + 61_000,
        }),
      ),
    ).toBe("timestamp_out_of_tolerance");

    // Same skew inside the default 5-minute window passes.
    const ok = verifyWebhook({
      secret: SECRET,
      payload: body,
      signature,
      timestamp,
      now: () => NOW_MS + 61_000,
    });
    expect(ok.event).toBe("invoice.settled");
  });

  test("toleranceMs: Infinity disables the replay check", () => {
    const { body, timestamp, signature } = makeDelivery();
    const event = verifyWebhook({
      secret: SECRET,
      payload: body,
      signature,
      timestamp,
      toleranceMs: Infinity,
      now: () => NOW_MS + 365 * 24 * 3600 * 1000,
    });
    expect(event.event).toBe("invoice.settled");
  });

  test("invalid_signature_format for non-hex and wrong-length signatures", () => {
    const { body, timestamp, signature } = makeDelivery();
    for (const bad of ["zz".repeat(32), signature.slice(0, 62), `${signature}ab`]) {
      expect(
        codeOf(() =>
          verifyWebhook({
            secret: SECRET,
            payload: body,
            signature: bad,
            timestamp,
            now: () => NOW_MS,
          }),
        ),
      ).toBe("invalid_signature_format");
    }
  });

  test("signature_mismatch for a wrong secret", () => {
    const { body, timestamp, signature } = makeDelivery();
    expect(
      codeOf(() =>
        verifyWebhook({
          secret: "whsec_other",
          payload: body,
          signature,
          timestamp,
          now: () => NOW_MS,
        }),
      ),
    ).toBe("signature_mismatch");
  });

  test("signature_mismatch for a tampered body", () => {
    const { timestamp, signature } = makeDelivery();
    const tampered = JSON.stringify({ id: "x", event: "invoice.settled", data: { amountSats: 9999 } });
    expect(
      codeOf(() =>
        verifyWebhook({
          secret: SECRET,
          payload: tampered,
          signature,
          timestamp,
          now: () => NOW_MS,
        }),
      ),
    ).toBe("signature_mismatch");
  });

  test("signature_mismatch when the timestamp header does not match the signed one", () => {
    const { body, signature } = makeDelivery();
    expect(
      codeOf(() =>
        verifyWebhook({
          secret: SECRET,
          payload: body,
          signature,
          timestamp: String(NOW_MS + 1),
          now: () => NOW_MS,
        }),
      ),
    ).toBe("signature_mismatch");
  });

  test("invalid_payload_json when the signature is valid but the body is not JSON", () => {
    const body = "not json";
    const signature = sign(SECRET, NOW_MS, body);
    expect(
      codeOf(() =>
        verifyWebhook({
          secret: SECRET,
          payload: body,
          signature,
          timestamp: String(NOW_MS),
          now: () => NOW_MS,
        }),
      ),
    ).toBe("invalid_payload_json");
  });
});

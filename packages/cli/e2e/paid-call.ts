/**
 * End-to-end paid-call verification against a live gateway tenant.
 *
 * Phase 1 (free)  — raw 402 challenge: header + body shape, invoice amount.
 * Phase 2 (paid)  — two L402 round-trips via NWC, timing each.
 *
 * Usage:
 *   bun packages/cli/e2e/paid-call.ts                          # phase 1 only
 *   NWC_URI='nostr+walletconnect://…' bun packages/cli/e2e/paid-call.ts
 *   NWC_URI=… bun packages/cli/e2e/paid-call.ts <slug> <path>  # non-default target
 *
 * Default target is btc-intel (our own tenant — paid sats land back in our
 * own wallet, so a run costs only routing fees).
 *
 * Lives in e2e/ (not src/) so it is excluded from the published package
 * (`files: ["dist"]`).
 */
import { L402Client, NwcWallet } from "@bolthub/pay";

const slug = process.argv[2] ?? "btc-intel";
const path = process.argv[3] ?? "/v1/history/summary";
const url = `https://${slug}.gw.bolthub.ai${path}`;
const MAX_PER_REQUEST_SATS = Number(process.env.MAX_PER_REQUEST_SATS ?? 25);

const failures: string[] = [];
function check(ok: boolean, label: string) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
  if (!ok) failures.push(label);
}

/** Convert a BOLT11 hrp amount (e.g. "50n") to sats. */
function bolt11AmountSats(invoice: string): number | null {
  const m = /^ln(?:bc|tbs?)(\d+)([munp])/.exec(invoice);
  if (!m) return null;
  const SATS_PER_BTC = 100_000_000;
  const mult = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 }[m[2] as "m" | "u" | "n" | "p"];
  return Number(m[1]) * mult * SATS_PER_BTC;
}

console.log(`Target: ${url}\n`);

// ── Phase 1: raw 402 challenge ──────────────────────────────────────────────
console.log("Phase 1 — unauthenticated request must return a clean L402 challenge");
const t0 = performance.now();
const raw = await fetch(url);
const challengeMs = Math.round(performance.now() - t0);
const body = (await raw.json().catch(() => null)) as {
  amountSats?: number;
  paymentHash?: string;
  paymentRequest?: string;
} | null;
const wwwAuth = raw.headers.get("www-authenticate") ?? "";

check(raw.status === 402, `status is 402 (got ${raw.status}, ${challengeMs}ms)`);
check(/^L402 /.test(wwwAuth), "WWW-Authenticate uses L402 scheme");
check(/macaroon="[^"]+"/.test(wwwAuth), "challenge contains macaroon");
check(/invoice="ln[^"]+"/.test(wwwAuth), "challenge contains BOLT11 invoice");
check(typeof body?.amountSats === "number", `body.amountSats present (${body?.amountSats})`);
check(!!body?.paymentHash && !!body?.paymentRequest, "body has paymentHash + paymentRequest");
const invoiceSats = body?.paymentRequest ? bolt11AmountSats(body.paymentRequest) : null;
check(
  invoiceSats !== null && invoiceSats === body?.amountSats,
  `invoice amount matches body (invoice=${invoiceSats} sats, body=${body?.amountSats} sats)`,
);

// ── Phase 2: paid round-trips ───────────────────────────────────────────────
const nwcUri = process.env.NWC_URI;
if (!nwcUri) {
  console.log("\nPhase 2 skipped — set NWC_URI to run the paid round-trip.");
} else {
  console.log("\nPhase 2 — paid round-trips via NWC");
  const { NWCClient } = await import("@getalby/sdk");
  const nwc = new NWCClient({ nostrWalletConnectUrl: nwcUri });
  const wallet = new NwcWallet({
    payInvoice: async (invoice: string) => {
      const result = await nwc.payInvoice({ invoice });
      return { preimage: result.preimage };
    },
  });
  const client = new L402Client({
    wallet,
    maxPerRequestSats: MAX_PER_REQUEST_SATS,
    budgetSats: MAX_PER_REQUEST_SATS * 4,
  });

  for (const attempt of [1, 2]) {
    const start = performance.now();
    try {
      const resp = await client.get(url);
      const ms = Math.round(performance.now() - start);
      const text = await resp.text();
      check(resp.status === 200, `call ${attempt}: 200 OK in ${ms}ms (${text.length} bytes)`);
      check(!/error/i.test(text.slice(0, 200)), `call ${attempt}: body is data, not an error envelope`);
      console.log(`    body: ${text.slice(0, 160)}`);
    } catch (err) {
      check(false, `call ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  nwc.close?.();
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(
  failures.length === 0
    ? "\nAll checks passed."
    : `\n${failures.length} check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);

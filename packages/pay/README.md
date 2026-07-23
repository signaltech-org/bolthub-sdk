# @bolthub/pay

The bolthub payments SDK — both sides of the sale, zero runtime dependencies.
Charge for an MCP tool (or HTTP endpoint) in a few lines, and pay for them
automatically. Lightning-only: settles over the **L402** rail. Implements the
[bolthub Tool Payment Profile](./docs/tool-payment-profile-v0.md); absorbed
`@bolthub/agent` (the HTTP L402 client + wallet adapters) in 0.4.0.

> **Status:** the package follows SemVer from `0.1.0`; the wire format it
> speaks (TPP `0.1`) is a draft and may evolve before 1.0. Breaking wire
> changes bump the minor version while the package is 0.x.

The agent↔tool protocol standardises *what a tool does* but has no slot for
*what it costs*. `@bolthub/pay` fills that slot: a paid tool answers an unpaid
call with a `payment_required` challenge, and runs only once the buyer pays the
Lightning invoice and returns a valid proof.

## Install

```bash
bun add @bolthub/pay
```

## Make one MCP tool chargeable

```ts
import { createPaywall, l402Rail } from "@bolthub/pay";

// A rail needs a signing secret (≥32 bytes) and something that makes invoices.
// Wrap your wallet (LND / NWC / LNbits / Phoenixd) or a bolthub facilitator.
const pay = createPaywall({
  rails: [
    l402Rail({
      secret: process.env.PAY_SECRET!,
      invoiceProvider: {
        async createInvoice(amountSat, memo) {
          const { invoice, paymentHash } = await myWallet.makeInvoice(amountSat, memo);
          return { invoice, paymentHash };
        },
      },
    }),
  ],
});

// Register it. `resource` defaults to the tool name; a proof is accepted only
// for the resource it was minted against.
pay.tool(
  server,
  "get_satellite_image",
  "Recent high-res satellite imagery for a lat/lon and date.",
  schema,
  { price: { amount: 2000 } }, // 2000 sat per call
  async (args) => ({ content: [{ type: "text", text: await fetchImage(args) }] }),
);
```

Or wrap a handler directly (equivalent), if you prefer to call `server.tool` yourself:

```ts
server.tool(
  "get_satellite_image",
  schema,
  pay(
    { price: { amount: 2000 }, resource: "get_satellite_image" },
    async (args) => ({ content: [{ type: "text", text: await fetchImage(args) }] }),
  ),
);
```

## What a buyer sees

1. **Unpaid call** → an error result whose `_meta["ai.bolthub/payment"]` holds the
   challenge:

   ```jsonc
   {
     "status": "payment_required",
     "price": { "amount": 2000, "asset": "sat" },
     "resource": "get_satellite_image",
     "offers": [
       { "scheme": "l402", "amount": 2000, "asset": "sat",
         "token": "…", "invoice": "lnbc20n1p…" }
     ],
     "expiresAt": 1751400000000
   }
   ```

2. The buyer pays an offer, then **re-calls the tool** with the proof in the
   request `_meta`:

   ```jsonc
   { "ai.bolthub/payment": { "scheme": "l402", "proof": "<token>:<preimageHex>" } }
   ```

3. The proof verifies → your handler runs.

A payment-blind client just sees a normal tool error (`"Payment required: 2000
sat …"`) and moves on; nothing breaks.

## Advertise the price (optional, for cost-aware agents)

```ts
const ad = pay.advertise({ amount: 2000 }); // → { version, price, model, rails }
// attach to the tool's _meta["ai.bolthub/payment"] so an agent can budget first
```

## Buyer side: pay for tools automatically

`ToolClient` is the seller wrapper's counterpart. It calls a tool, and if it
gets a `payment_required` challenge it pays the L402 offer and retries, staying
within a budget you set. (Known as `PayingClient` before 0.3.0; that name
remains as a deprecated alias.)

```ts
import { ToolClient, l402Payer } from "@bolthub/pay";

const client = new ToolClient({
  payers: [l402Payer({ wallet: myLightningWallet })], // pays L402 invoices
  maxTotal: { sat: 10_000 },                          // per-asset budget
  onPaid: (i) => console.log(`paid ${i.amount} ${i.asset} via ${i.scheme}`),
});

// callTool handles challenge → pay → retry transparently:
const result = await client.callTool(mcpClient, "get_satellite_image", { lat, lon });
```

`l402Payer`'s wallet is the same `WalletAdapter` the built-in adapters
implement, so `LndWallet`, `PhoenixdWallet`, `NwcWallet`, etc. drop straight in.

## Buyer side: pay for HTTP APIs (L402)

For paywalled **HTTP** endpoints (a gateway answering `402 Payment Required`
with a `WWW-Authenticate: L402` challenge), use `L402Client` — merged in from
`@bolthub/agent` in 0.4.0. It pays the embedded Lightning invoice and retries
with the proof, caching session tokens between calls:

```ts
import { L402Client, LndWallet } from "@bolthub/pay";

const client = new L402Client({
  wallet: new LndWallet({ host, macaroon }),
  budgetSats: 10_000,
  maxPerRequestSats: 100,
});
const resp = await client.get("https://acme.gw.bolthub.ai/v1/weather", {
  params: { city: "berlin" },
});
```

Wallet adapters: `LndWallet`, `LnbitsWallet`, `PhoenixdWallet`, `NwcWallet`
(pass any NWC connection, e.g. `@getalby/sdk`'s `NWCClient`), and `WebLnWallet`
for the browser build. `walletFromEnv()` builds one from the standard env vars
(`LND_REST_HOST`/`LND_MACAROON`, `LNBITS_URL`/`LNBITS_ADMIN_KEY`,
`PHOENIXD_URL`/`PHOENIXD_PASSWORD`, `NWC_URI`). `attenuate()` narrows an L402
macaroon offline to delegate a restricted credential to a sub-agent.

### Streaming endpoints (SSE)

For a paid endpoint that answers with a live `text/event-stream` body, pass
`streaming: true` (0.8.0+): `timeoutMs` then bounds only the time to response
headers on each leg of the L402 flow, never the body read, so the stream can
run indefinitely. Stop it by aborting a `signal` you pass in:

```ts
const ctrl = new AbortController();
const resp = await client.get("https://acme.gw.bolthub.ai/v1/live-feed", {
  streaming: true,
  signal: ctrl.signal,
});
const reader = resp.body!.getReader();
// read events as they arrive; ctrl.abort() closes the stream cleanly
```

### Prepaid credit, receipts, and free retries

`L402Client` adds three agent-native behaviors on top of pay-and-retry:

- **Prepaid credit.** `buyCredit(url, sats)` pays once for a face-value sats
  budget spendable across ALL of that provider's `per_request` endpoints;
  subsequent calls to the provider draw the budget with no further payment
  until it is spent. `batchFetch(urls, { creditSats })` groups URLs by
  provider and buys one credit per provider. (Replaces the per-endpoint
  bundles retired in 0.6.0 — `buyBundle` now throws.)

  ```ts
  await client.buyCredit("https://acme.gw.bolthub.ai/v1/data", 500);
  for (let i = 0; i < 100; i++) await client.get("https://acme.gw.bolthub.ai/v1/data");
  ```

- **Free retries on origin failure.** When the origin is unreachable or answers
  5xx/408/429 after you have paid, your proof stays spendable and the client
  re-sends for free. On by default (`retryOnUpstreamFailure`).

- **Verifiable receipts.** Point the client at a receipt store and every paid
  call records a preimage-backed receipt you can export and verify offline.
  Redacted exports keep the expense record but strip the preimage.

  ```ts
  import { L402Client, FileReceiptStore } from "@bolthub/pay";

  const client = new L402Client({ wallet, receiptStore: new FileReceiptStore() });
  // ... paid calls ...
  const csv = client.exportReceipts({ format: "csv", redact: true });
  ```

## One budget across both buyer paths

`Budget` is the shared per-asset pool. Hand the same instance to a
`ToolClient` (MCP-wire payments) and an `L402Client` (HTTP-402 payments) and
together they can never spend past `maxTotal` — reservations are synchronous,
so even concurrent calls across the two paths can't jointly overspend:

```ts
import { Budget, ToolClient, L402Client, l402Payer } from "@bolthub/pay";

const budget = new Budget({ maxTotal: { sat: 10_000 }, maxPerCall: { sat: 500 } });
const tools = new ToolClient({ payers: [l402Payer({ wallet })], budget });
const http = new L402Client({ wallet, budget });
```

## Verify tenant webhooks

If you subscribe to bolthub webhooks (`invoice.settled`, `billing.*`, and
friends), `verifyWebhook` checks the delivery signature and returns the parsed
event. It enforces a replay window (default 5 minutes) and uses a
constant-time compare. Every failure throws `WebhookVerificationError` with a
typed `code` such as `signature_mismatch` or `timestamp_out_of_tolerance`.

```ts
import { verifyWebhook, WebhookVerificationError } from "@bolthub/pay";

// Express: use express.raw() so req.body is the raw bytes.
app.post("/webhooks/bolthub", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = verifyWebhook({
      secret: process.env.BOLTHUB_WEBHOOK_SECRET!,
      payload: req.body,
      signature: req.header("x-webhook-signature")!,
      timestamp: req.header("x-webhook-timestamp")!,
    });
    if (event.event === "invoice.settled") {
      // event.data is the invoice payload
    }
    res.sendStatus(200);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
});
```

The signature covers the raw request body, so capture it before any JSON
parser runs. Node-only: this export is not in the browser build.

## Adding a rail

The paywall core is rail-agnostic. Implement [`PaymentRail`](./src/types.ts)
(`assets`, `createOffer(price, resource)`, and `verify(proof, ctx)`) and pass it
in `rails`. The core never sees rail-specific bytes, so a new rail is purely
additive.

## Security

- Tokens are HMAC-signed, scoped to a `resource`, and time-limited (default 15 min).
- Signature and preimage checks are constant-time.
- The wrapper **fails closed**: no `resource`, or any unverifiable proof, means no service.
- A proof minted for one tool can never unlock another (`resource` mismatch is rejected).

See the [spec](./docs/tool-payment-profile-v0.md) for the wire format
and the HTTP transport profile.

## License

MIT

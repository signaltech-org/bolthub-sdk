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
// Wrap your wallet (NWC / LND / phoenixd / LNbits) or a bolthub facilitator.
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

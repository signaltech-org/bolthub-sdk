# @bolthub/pay

Charge for an MCP tool (or HTTP endpoint) in a few lines. Rail-agnostic: ships
the **L402 (Lightning)** rail today; **x402 (stablecoin)** drops in behind the
same interface. Seller side of the [bolthub Tool Payment Profile](./docs/tool-payment-profile-v0.md).

> **Status:** the package follows SemVer from `0.1.0`; the wire format it
> speaks (TPP `0.1`) is a draft and may evolve before 1.0. Breaking wire
> changes bump the minor version while the package is 0.x.

The agent↔tool protocol standardises *what a tool does* but has no slot for
*what it costs*. `@bolthub/pay` fills that slot: a paid tool answers an unpaid
call with a `payment_required` challenge, and runs only once a valid proof comes
back — over whatever rail you accept.

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

`PayingClient` is the seller wrapper's counterpart. It calls a tool, and if it
gets a `payment_required` challenge it pays an offer it has a *payer* for and
retries — enforcing a per-asset budget.

```ts
import { PayingClient, l402Payer, x402Payer } from "@bolthub/pay";

const client = new PayingClient({
  payers: [
    l402Payer({ wallet: myLightningWallet }), // pays L402 invoices
    x402Payer({ signer: myUsdcSigner }),      // signs x402 payments
  ],
  maxTotal: { sat: 10_000, usdc: 5_000 },     // per-asset budget
  onPaid: (i) => console.log(`paid ${i.amount} ${i.asset} via ${i.scheme}`),
});

// callTool handles challenge → pay → retry transparently:
const result = await client.callTool(mcpClient, "get_satellite_image", { lat, lon });
```

Payers are tried in order, so the list is your rail preference. `l402Payer`'s
wallet is structurally `@bolthub/agent`'s `WalletAdapter`, so existing wallets
(NWC / LND / phoenixd) drop straight in.

See the whole loop — one tool, both rails, no testnet needed:

```bash
bun run packages/pay/examples/two-rails-demo.ts
```

## Two rails, one tool

Price a tool in more than one asset and it offers both rails — the buyer pays in
whichever they hold:

```ts
import { createPaywall, l402Rail, x402Rail } from "@bolthub/pay";

const pay = createPaywall({
  rails: [
    l402Rail({ secret, invoiceProvider }),
    x402Rail({ network: "base", asset: USDC_ADDRESS, payTo, facilitator }),
  ],
});

pay.tool(server, "get_satellite_image", "Recent imagery", schema,
  { price: [{ amount: 2000, asset: "sat" }, { amount: 5000, asset: "usdc" }] },
  async (args) => ({ content: [{ type: "text", text: await fetchImage(args) }] }));
// One challenge, two offers. Pay the Lightning invoice OR sign the USDC transfer.
```

The x402 rail follows the [x402](https://www.x402.org/) model: it advertises
payment requirements and delegates verify/settle to a **facilitator**
(Coinbase-hosted or self-hosted) you inject — no on-chain crypto dependency.

## Adding a rail

Implement [`PaymentRail`](./src/types.ts) — `assets`, `createOffer(price,
resource)`, and `verify(proof, ctx)` — and pass it in `rails`. The paywall core
never sees rail-specific bytes, so a new rail (cards, another chain) is purely
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

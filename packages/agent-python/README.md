# bolthub

The bolthub payments SDK for Python, mirroring [`@bolthub/pay`](https://www.npmjs.com/package/@bolthub/pay):

- **Buyer, HTTP**: `L402Client` handles `402 Payment Required` challenges, pays the Lightning invoice, and retries with proof of payment.
- **Buyer, MCP**: `ToolClient` pays Tool Payment Profile (TPP) challenges on the MCP wire.
- **Seller**: `create_paywall` + rails turn any MCP tool handler into a paid one, wire-compatible with the TypeScript SDK and the bolthub gateway.

## Install

```bash
pip install bolthub

# Optional: Nostr Wallet Connect (NwcWallet.from_uri)
pip install 'bolthub[nwc]'
```

The only required runtime dependency is `httpx`. NWC support pulls in
`websockets` and `cryptography` via the `nwc` extra.

## Quick Start

```python
from bolthub import L402Client, LndWallet

wallet = LndWallet(
    host="https://your-lnd-node:8080",
    macaroon="0201036c6e...",
)

client = L402Client(wallet, budget_sats=10_000)

resp = client.get(
    "https://acme.gw.bolthub.ai/v1/market-data",
    params={"symbol": "BTC"},
)
data = resp.json()
```

## Wallet Adapters

### LND (recommended)

Full Lightning node. Self-host or use the bolthub Node Launcher, [Umbrel](https://umbrel.com), or [Start9](https://start9.com). Fastest payment path (<200ms) and full control.

```python
from bolthub import LndWallet

wallet = LndWallet(
    host="https://your-lnd-node:8080",
    macaroon="admin-macaroon-hex",
    timeout_seconds=30,
)
```

For agent deployments, use a scoped pay-only macaroon instead of `admin.macaroon`:

```bash
lncli bakemacaroon uri:/lnrpc.Lightning/SendPaymentSync \
  uri:/lnrpc.Lightning/DecodePayReq \
  --save_to=pay-only.macaroon
```

### NWC (Nostr Wallet Connect)

Easiest to set up but slower (1-3s per payment). No node required. Get a free NWC connection from [CoinOS](https://coinos.io) or use [Alby Hub](https://getalby.com), Zeus, or Primal.

Configure directly from the connection URI (requires the `nwc` extra,
`pip install 'bolthub[nwc]'`):

```python
from bolthub import NwcWallet

wallet = NwcWallet.from_uri(
    "nostr+walletconnect://<wallet_pubkey>?relay=wss://relay.example.com&secret=<hex>"
)
```

For the async client, use `AsyncNwcWallet.from_uri(...)`. You can still pass your
own callback if you prefer to drive NWC yourself:

```python
wallet = NwcWallet(pay_fn=lambda bolt11: my_nwc_pay(bolt11))  # returns preimage hex
```

### LNbits

Supported if you already run LNbits. Multi-wallet accounts system; create a dedicated wallet for your agent.

```python
from bolthub import LnbitsWallet

wallet = LnbitsWallet(
    url="https://lnbits.example.com",
    admin_key="your-admin-key",
)
```

### Phoenixd

Supported if you already run Phoenixd for outbound payments.

```python
from bolthub import PhoenixdWallet

wallet = PhoenixdWallet(
    url="https://your-phoenixd:9740",
    password="your-phoenixd-password",
    timeout_seconds=35,
)
```

### Custom Wallet

Implement the `WalletAdapter` protocol:

```python
class MyWallet:
    def pay_invoice(self, bolt11: str) -> str:
        preimage = my_payment_logic(bolt11)
        return preimage
```

## Async

`AsyncL402Client` mirrors `L402Client` on `httpx.AsyncClient`. Existing
(synchronous) wallets work unchanged — they are run in a worker thread — or use
the async adapters (`AsyncLndWallet`, `AsyncLnbitsWallet`, `AsyncPhoenixdWallet`,
`AsyncNwcWallet`) for a fully non-blocking path.

```python
from bolthub import AsyncL402Client, LndWallet

async def main():
    async with AsyncL402Client(LndWallet(host=host, macaroon=mac), budget_sats=10_000) as client:
        resp = await client.get("https://acme.gw.bolthub.ai/v1/market-data")
        return resp.json()
```

## Use with your own httpx client (`L402Auth`)

`L402Auth` plugs the L402 flow into a client you own, so you keep your transport,
pooling, and retries. It works with both `httpx.Client` and `httpx.AsyncClient`:

```python
import httpx
from bolthub import L402Auth, LndWallet

auth = L402Auth(LndWallet(host=host, macaroon=mac), budget_sats=10_000)

with httpx.Client(auth=auth) as client:
    resp = client.get("https://acme.gw.bolthub.ai/v1/market-data")

print(auth.total_spent)
```

## Budget Guards

```python
client = L402Client(
    wallet,
    max_per_request_sats=100,  # reject invoices over 100 sats
    budget_sats=10_000,         # total spending cap
)

print(client.total_spent)       # sats spent so far
print(client.remaining_budget)  # sats remaining
```

The price of each invoice is determined from the response body (`amountSats`),
the BOLT11 invoice itself, or an optional `price_header`. If it still cannot be
determined, `on_unknown_amount` controls what happens — by default (`"cap"`) the
client pays only up to `max_per_request_sats` and refuses outright if no ceiling
is set, so a price-less challenge is never paid blind. Use `"refuse"` to always
refuse, or `"allow"` for the legacy pay-blind behaviour.

## Thread Safety

A single `L402Client` (or `L402Auth`) may be shared across threads. Budget
accounting is atomic, so `total_spent` is always exact and the budget is never
exceeded under concurrent requests; the lock is held only around the budget
check, not across the network or payment, so requests still run in parallel.

## Session Persistence

By default sessions are kept in memory. Use `FileSessionStore` to persist
tokens across process restarts (stored in `~/.bolthub/sessions.json`):

```python
from bolthub import L402Client, LndWallet, FileSessionStore

client = L402Client(
    LndWallet(host=host, macaroon=macaroon),
    session_store=FileSessionStore(),
)
```

## Prepaid bundles

On a `per_request` endpoint that offers them, `buy_bundle` pays once for an
N-use credential. Ordinary `get`/`post`/`request` calls to the same URL then
spend it down with no further payment, until it runs out.

```python
# One Lightning payment for 100 calls to this endpoint.
client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)

for _ in range(100):
    client.get("https://acme.gw.bolthub.ai/v1/data")  # no invoice paid
```

You pass the size, not the price: the gateway sets the amount from the seller's
offer, so a client can't underpay. A bundle honors the same `budget_sats` and
`max_cost_sats` caps and is scoped to the one endpoint you bought it for.
`AsyncL402Client` exposes the same `await client.buy_bundle(...)`.

## Free retries on origin failure

When the gateway's origin is unreachable or answers 5xx/408/429 after you have
paid, your proof stays spendable and the client re-sends for free. On by default
(`retry_on_upstream_failure=True`); set `throw_on_upstream_failure=True` to get
an exception instead.

## Receipts

Point the client at a `receipt_store` and every paid call records one
preimage-backed receipt you can export and verify offline, with no service in
the loop.

```python
from bolthub import L402Client, FileReceiptStore

client = L402Client(wallet, receipt_store=FileReceiptStore())
# ... paid calls happen ...
csv_report = client.export_receipts(format="csv", redact=True)
```

Receipt files carry live preimages, so treat them like credentials and export
with `redact=True` for shareable reports. `verify_receipt(receipt)` runs the
offline proof-of-payment checks.

## Selling: paywall an MCP tool (TPP)

`create_paywall` wraps any tool handler so a call must carry a valid payment
proof. It implements the [bolthub Tool Payment Profile](https://github.com/signaltech-org/bolthub-sdk/blob/main/packages/pay/docs/tool-payment-profile-v0.md):
an unpaid call returns a `payment_required` challenge in
`result["_meta"]["ai.bolthub/payment"]`; a call carrying a verified proof runs
the real handler. Framework-agnostic: handlers take `(args, extra)` and return
a dict-shaped `ToolResult`, so there is no MCP SDK dependency (both `def` and
`async def` handlers work).

```python
from bolthub import create_paywall, l402_rail

class MyInvoices:
    def create_invoice(self, amount_sat: int, memo: str) -> tuple[str, str]:
        """Return (bolt11_invoice, payment_hash_hex) from your node/wallet."""
        ...

pay = create_paywall(rails=[l402_rail(SECRET, MyInvoices())])

# Wrap a handler directly...
paid_handler = pay(get_image, price={"amount": 2000, "asset": "sat"},
                   resource="get_satellite_image")

# ...or register on an MCP-style server (resource defaults to the tool name):
pay.tool(server, "get_satellite_image", "Recent imagery", schema, get_image,
         price={"amount": 2000})

pay.advertise({"amount": 2000})  # discovery-time price advertisement
```

To run on the hosted path instead of minting locally, swap the rail:
`facilitator_rail("l402", ["sat"], http_facilitator(base_url, api_key))`.

## Buying: pay for MCP tool calls (`ToolClient`)

`ToolClient` is the buyer-side counterpart: it calls a tool, and when the
result is a `payment_required` challenge it picks an offer it has a payer for,
budget-gates it, pays, and retries the call with the proof in `_meta`.

```python
from bolthub import Budget, ToolClient, l402_payer, NwcWallet

buyer = ToolClient(
    [l402_payer(NwcWallet.from_uri(NWC_URI))],
    max_total={"sat": 10_000},     # per-asset lifetime ceiling
    max_per_call={"sat": 500},     # per-asset per-call ceiling
)
result = buyer.call_tool(mcp_client, "get_satellite_image", {"lat": 47.5})
buyer.spent_for("sat")             # 2000
```

Pass one shared `Budget(max_total={"sat": 10_000})` as `budget=` to several
clients to enforce a single spending pool across them — including the HTTP
`L402Client`/`AsyncL402Client` (0.4.1+), so the MCP and HTTP-402 payment
paths can never jointly overspend. Budget violations raise
`PaymentBudgetError` (`L402BudgetError` on the HTTP clients); failed payments
roll the reservation back. The HTTP clients also take a per-request
`max_cost_sats=` ceiling and `on_paid=` callbacks (client-level and
per-request) for exact cost attribution.

Token primitives (`sign_l402_token`, `verify_l402_token`, `verify_preimage`,
`sha256_hex`, `random_preimage`) are exported too, and produce byte-identical
tokens to the TypeScript SDK (asserted by shared golden vectors in
`tests/fixtures/tpp_vectors.json`).

## Delegation (attenuation)

A paid L402 macaroon can be *narrowed offline* and handed to a sub-agent, so a
parent agent can delegate a restricted credential without re-paying. Needs the
optional `pymacaroons` dependency (`pip install bolthub[delegation]`):

```python
import time
from bolthub import attenuate

# `macaroon` is the value from `Authorization: L402 <macaroon>:<preimage>`.
restricted = attenuate(
    macaroon,
    method="GET",
    valid_until=int(time.time() * 1000) + 60_000,  # 60s, tighter than the original
)
# Give `restricted` plus the SAME preimage to the sub-agent.
```

The gateway enforces every caveat down the chain (most restrictive wins).

## API Reference

| Export | Description |
|--------|-------------|
| `L402Client` | HTTP client with automatic L402 challenge handling |
| `AsyncL402Client` | Async client on `httpx.AsyncClient` |
| `L402Auth` | `httpx.Auth` for plugging L402 into your own client |
| `LndWallet` / `AsyncLndWallet` | Wallet adapter for LND REST API |
| `LnbitsWallet` / `AsyncLnbitsWallet` | Wallet adapter for LNbits |
| `PhoenixdWallet` / `AsyncPhoenixdWallet` | Wallet adapter for Phoenixd |
| `NwcWallet` / `AsyncNwcWallet` | NWC wallet; `from_uri(...)` for NIP-47 (needs `bolthub[nwc]`) |
| `SyncWalletAdapter` | Run a sync wallet under the async client |
| `WalletAdapter` / `AsyncWalletAdapter` | Protocols for custom wallets |
| `FileSessionStore` / `InMemorySessionStore` | Session token storage |
| `SessionStore` | Protocol for custom session storage |
| `FileReceiptStore` / `InMemoryReceiptStore` | Receipt ledger storage (preimage-backed proof of payment) |
| `ReceiptStore` | Protocol for custom receipt storage |
| `export_receipts(...)` / `verify_receipt(...)` | Serialize receipts to JSON/CSV; verify one offline |
| `L402Error` | Base exception for L402 failures |
| `L402BudgetError` | Raised when budget limits are exceeded |
| `attenuate(...)` | Narrow a macaroon offline to delegate a restricted credential (needs `bolthub[delegation]`) |
| `create_paywall(rails=...)` / `Paywall` | Seller: wrap MCP tool handlers behind a TPP paywall |
| `l402_rail(secret, invoice_provider)` | L402 settlement rail (mints invoice + signed token, verifies proofs) |
| `facilitator_rail(...)` / `http_facilitator(...)` | Rail that delegates mint/verify to a hosted bolthub facilitator |
| `ToolClient` | Buyer: pay-and-retry client for TPP challenges on the MCP wire |
| `l402_payer(wallet)` | Buyer-side L402 payer (`<token>:<preimage>` proofs) |
| `Budget` | Per-asset reserve/rollback spending pool, shareable across clients |
| `PaymentError` / `PaymentBudgetError` | Buyer-side payment failures / budget violations |
| `get_payment_challenge(result)` | Extract a `payment_required` challenge from a tool result |
| `sign_l402_token` / `verify_l402_token` | HMAC-signed L402 token primitives (wire-compatible with `@bolthub/pay`) |
| `verify_preimage` / `sha256_hex` / `random_preimage` | Preimage and hash helpers |
| `PAYMENT_META_KEY` / `SPEC_VERSION` | TPP `_meta` key (`ai.bolthub/payment`) and spec version (`0.1`) |
| `PaymentRail` / `PaymentPayer` / `InvoiceProvider` / `FacilitatorTransport` | Protocols for custom rails, payers, and invoice backends |

## License

MIT

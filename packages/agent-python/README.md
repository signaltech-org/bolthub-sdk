# bolthub

L402 client for AI agents. Automatically handles 402 Payment Required challenges, pays Lightning invoices, and retries requests with proof of payment.

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
| `L402Error` | Base exception for L402 failures |
| `L402BudgetError` | Raised when budget limits are exceeded |

## License

MIT

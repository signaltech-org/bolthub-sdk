# bolthub

L402 client for AI agents. Automatically handles 402 Payment Required challenges, pays Lightning invoices, and retries requests with proof of payment.

## Install

```bash
pip install bolthub
```

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

```python
from bolthub import NwcWallet

# Provide a pay function that handles the NWC protocol.
# With pynostr or another NWC library:
def pay_via_nwc(bolt11: str) -> str:
    # your NWC payment logic here
    return preimage_hex

wallet = NwcWallet(pay_fn=pay_via_nwc)
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
| `LndWallet` | Wallet adapter for LND REST API |
| `LnbitsWallet` | Wallet adapter for LNbits |
| `PhoenixdWallet` | Wallet adapter for Phoenixd |
| `NwcWallet` | Wallet adapter accepting a custom pay callback |
| `WalletAdapter` | Protocol to implement for custom wallets |
| `FileSessionStore` | Disk-backed session token persistence |
| `SessionStore` | Protocol for custom session storage |
| `L402Error` | Base exception for L402 failures |
| `L402BudgetError` | Raised when budget limits are exceeded |

## License

MIT

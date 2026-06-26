# @bolthub/agent

L402 client for AI agents. Automatically handles 402 Payment Required challenges, pays Lightning invoices, and retries requests with proof of payment.

## Install

```bash
npm install @bolthub/agent
```

## Quick Start

```typescript
import { L402Client, LndWallet } from "@bolthub/agent";

const wallet = new LndWallet({
  host: "https://your-lnd-node:8080",
  macaroon: "0201036c6e...",
});

const client = new L402Client({
  wallet,
  maxPerRequestSats: 100,
  budgetSats: 10_000,
});

const resp = await client.get(
  "https://acme.gw.bolthub.ai/v1/weather",
  { params: { city: "berlin" } }
);
const data = await resp.json();
```

## Wallet Adapters

### LND

```typescript
import { LndWallet } from "@bolthub/agent";

const wallet = new LndWallet({
  host: "https://your-lnd-node:8080",
  macaroon: "admin-macaroon-hex",
  timeoutSeconds: 30,
});
```

### LNbits

```typescript
import { LnbitsWallet } from "@bolthub/agent";

const wallet = new LnbitsWallet({
  url: "https://lnbits.example.com",
  adminKey: "your-admin-key",
});
```

### NWC (Nostr Wallet Connect)

```typescript
import { NwcWallet } from "@bolthub/agent";

const wallet = new NwcWallet(nwcConnection);
```

### Custom Wallet

Implement the `WalletAdapter` interface:

```typescript
import type { WalletAdapter } from "@bolthub/agent";

const myWallet: WalletAdapter = {
  async payInvoice(bolt11: string) {
    const preimage = await myPaymentLogic(bolt11);
    return { preimage };
  },
};
```

## Budget Guards

```typescript
const client = new L402Client({
  wallet,
  maxPerRequestSats: 100,   // reject invoices over 100 sats
  budgetSats: 10_000,        // total spending cap
});

console.log(client.totalSpent);      // sats spent so far
console.log(client.remainingBudget); // sats remaining
```

The price of each invoice is determined from the response body (`amountSats`),
the BOLT11 invoice itself, or an optional `priceHeader`. If it still cannot be
determined, `onUnknownAmount` controls what happens — by default (`"cap"`) the
client pays only up to `maxPerRequestSats` and refuses outright if no ceiling is
set, so a price-less challenge is never paid blind. Use `"refuse"` to always
refuse, or `"allow"` for the legacy pay-blind behaviour. Budget accounting is
also concurrency-safe: requests issued together (e.g. via `Promise.all`) can
never overspend.

## Session Persistence

By default sessions are kept in memory. Use `FileSessionStore` to persist
tokens across process restarts (stored in `~/.bolthub/sessions.json`):

```typescript
import { L402Client, LndWallet, FileSessionStore } from "@bolthub/agent";

const client = new L402Client({
  wallet: new LndWallet({ host, macaroon }),
  sessionStore: new FileSessionStore(),
});
```

## Delegation (attenuation)

A real L402 macaroon can be *narrowed offline* and handed to a sub-agent, so a
parent agent that paid for access can delegate a restricted credential without
re-paying or calling bolthub:

```ts
import { attenuate } from "@bolthub/agent";

// `macaroon` is the value from `Authorization: L402 <macaroon>:<preimage>`.
const restricted = attenuate(macaroon, {
  method: "GET", // only GET requests
  validUntil: Date.now() + 60_000, // expires in 60s, tighter than the original
});
// Give `restricted` plus the SAME preimage to the sub-agent, which sends
//   Authorization: L402 <restricted>:<preimage>
```

The gateway enforces every caveat down the chain (most restrictive wins).

## API Reference

| Export | Description |
|--------|-------------|
| `L402Client` | HTTP client with automatic L402 challenge handling |
| `LndWallet` | Wallet adapter for LND REST API |
| `LnbitsWallet` | Wallet adapter for LNbits |
| `PhoenixdWallet` | Wallet adapter for Phoenixd |
| `NwcWallet` | Wallet adapter for Nostr Wallet Connect |
| `WebLnWallet` | Browser-only wallet via the WebLN provider |
| `isWebLnAvailable()` | Check if a WebLN provider exists |
| `FileSessionStore` | Disk-backed session token persistence |
| `createL402Client()` | Shorthand factory for `L402Client` |
| `attenuate()` | Narrow a macaroon offline to delegate a restricted credential |
| `WalletAdapter` | Interface to implement for custom wallets |
| `L402Error` | Base error class for L402 failures |
| `L402BudgetError` | Thrown when budget limits are exceeded |
| `L402PaymentError` | Thrown when the wallet fails to pay |
| `L402TimeoutError` | Thrown when a request times out |

## License

MIT

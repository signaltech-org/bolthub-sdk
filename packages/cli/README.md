# @bolthub/cli

CLI for the bolthub tool directory. Search, explore, and call paid APIs from the terminal.

## Install

```bash
npm install -g @bolthub/cli
```

Or run directly with `npx`:

```bash
npx @bolthub/cli search bitcoin
```

## Commands

### `search` - Find APIs

```bash
bolthub search bitcoin
bolthub search --tag finance
bolthub search                  # list all
```

### `info` - API details

```bash
bolthub info btc-intel
```

Shows all endpoints, pricing models, and usage instructions.

### `call` - Call an endpoint

```bash
bolthub call btc-intel "/v1/history/candles?timeframe=1h&limit=2"
bolthub call btc-intel /v1/market/snapshot --max-cost 10
```

| Option | Description |
|--------|-------------|
| `--method <METHOD>` | HTTP method (default: GET) |
| `--max-cost <sats>` | Refuse invoices above this amount |
| `--budget <sats>` | Total session spending limit |
| `--body <json>` | JSON request body for POST/PUT/PATCH |

### `receipts` - Export and verify payments

```bash
bolthub receipts export --format csv --redact
bolthub receipts verify
```

`export` serializes your local receipt ledger (`~/.bolthub/receipts.jsonl`) to
JSON or CSV; `--redact` strips preimages for a shareable expense report. `verify`
runs the offline proof-of-payment checks on every receipt. `export` also takes
`--from`/`--to` (ISO dates) and `--file <path>`.

## Wallet Configuration

The CLI needs a Lightning wallet to pay for API calls. Set one of these
environment variable pairs:

| Variables | Wallet | Speed |
|-----------|--------|-------|
| `LND_REST_HOST` + `LND_MACAROON` | LND (recommended) | <200ms |
| `NWC_URI` | NWC (bundled, no extra install) | 1-3s |
| `LNBITS_URL` + `LNBITS_ADMIN_KEY` | LNbits | <300ms |
| `PHOENIXD_URL` + `PHOENIXD_PASSWORD` | Phoenixd (if you already run it) | <200ms |

## License

MIT

# @bolthub/cli

CLI for the BoltHub L402 API marketplace. Search, explore, and call paid APIs from the terminal.

## Install

```bash
npm install -g @bolthub/cli
```

Or run directly with `npx`:

```bash
npx @bolthub/cli search weather
```

## Commands

### `search` - Find APIs

```bash
bolthub search weather
bolthub search --tag finance
bolthub search                  # list all
```

### `info` - API details

```bash
bolthub info pokemon
```

Shows all endpoints, pricing models, and usage instructions.

### `call` - Call an endpoint

```bash
bolthub call pokemon /v2/pokemon/pikachu
bolthub call ai-text /v1/summarize --method POST --body '{"text":"hello"}'
bolthub call bitcoin-data /v1/prices --max-cost 10
```

| Option | Description |
|--------|-------------|
| `--method <METHOD>` | HTTP method (default: GET) |
| `--max-cost <sats>` | Refuse invoices above this amount |
| `--budget <sats>` | Total session spending limit |
| `--body <json>` | JSON request body for POST/PUT/PATCH |

## Wallet Configuration

The CLI needs a Lightning wallet to pay for API calls. Set one of these
environment variable pairs:

| Variables | Wallet | Speed |
|-----------|--------|-------|
| `PHOENIXD_URL` + `PHOENIXD_PASSWORD` | Phoenixd (recommended) | <200ms |
| `LND_REST_HOST` + `LND_MACAROON` | LND | <200ms |
| `LNBITS_URL` + `LNBITS_ADMIN_KEY` | LNbits | <300ms |
| `NWC_URI` | NWC (bundled, no extra install) | 1-3s |

## License

MIT

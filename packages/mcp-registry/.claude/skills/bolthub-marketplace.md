---
name: bolthub-marketplace
description: Search, discover, and call paid APIs on the bolthub marketplace. Every API is pay-per-call via Lightning — no accounts, API keys, or KYC needed.
---

# bolthub Marketplace

bolthub is an L402 API marketplace where AI agents can discover and call paid APIs using Lightning micropayments. Payments are instant, non-custodial, and require no signup.

## Setup

If the MCP server is not already configured, add it to the project's MCP config:

```bash
claude mcp add --transport stdio bolthub -- npx @bolthub/mcp-registry
```

Or with a wallet and budget:

```bash
claude mcp add --transport stdio \
  --env NWC_URI="<nwc-connection-string>" \
  --env BUDGET_SATS="1000" \
  bolthub -- npx @bolthub/mcp-registry
```

Wallet environment variables (only one type needed):

| Variable | Speed | Description |
|----------|-------|-------------|
| `PHOENIXD_URL` + `PHOENIXD_PASSWORD` | <200ms | Recommended. Self-custodial via Nodana or self-hosted. |
| `LND_REST_HOST` + `LND_MACAROON` | <200ms | Fastest. Requires self-hosted LND node. |
| `LNBITS_URL` + `LNBITS_ADMIN_KEY` | <300ms | Open-source accounts system. |
| `NWC_URI` | 1-3s | Easiest. Works with CoinOS (free), Alby Hub, Phoenix. |

`BUDGET_SATS` is optional — caps total spending per session. Omit for unlimited.

## Available Tools

Once configured, three MCP tools are available:

### search_apis

Search the marketplace for APIs by keyword or tag.

```
search_apis({ query: "weather" })
search_apis({ tag: "finance" })
search_apis()  // list all
```

### get_api_details

Get full endpoint details, pricing, and examples for a specific API.

```
get_api_details({ slug: "bitcoin-data" })
```

### call_api

Call any API endpoint. L402 Lightning payments are handled automatically.

```
call_api({ slug: "bitcoin-data", path: "/v1/prices", method: "GET" })
call_api({ slug: "ai-text", path: "/v1/summarize", method: "POST", body: { text: "..." } })
```

## Workflow

1. Use `search_apis` to find APIs relevant to the task
2. Use `get_api_details` to understand endpoints, pricing, and expected parameters
3. Use `call_api` to make the actual request — payment is automatic

## Pricing

Each API sets its own pricing (typically 1-50 sats per request). The agent's wallet pays automatically on each call. Common models:

- **per_request** — fixed sats per call
- **time_pass** — one payment for N minutes of unlimited access
- **token_bucket** — one payment for N requests
- **metered** — prepaid balance deducted per call

## Alternative: lnget

APIs on bolthub also work with `lnget` from Lightning Agent Tools:

```bash
lnget --max-cost 100 https://{slug}.gw.bolthub.ai{path}
```

## Links

- API Hub: https://bolthub.ai/hub
- Docs: https://docs.bolthub.ai
- MCP Registry: https://docs.bolthub.ai/docs/sdks/mcp-bridge

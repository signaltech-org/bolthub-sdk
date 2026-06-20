# @bolthub/mcp-registry

MCP server that gives AI agents access to **every API** on the bolthub marketplace. One config entry, every API, forever. New APIs are instantly available, with no config changes needed.

Source: [signaltech-org/bolthub-sdk](https://github.com/signaltech-org/bolthub-sdk) · Docs: [docs.bolthub.ai](https://docs.bolthub.ai/docs/sdks/mcp-registry)

## Install

```bash
npm install -g @bolthub/mcp-registry
```

Or use directly with `npx`:

```bash
npx @bolthub/mcp-registry
```

## Configuration

Add to your MCP client config (Cursor, Claude Desktop, OpenClaw, etc.):

```json
{
  "mcpServers": {
    "bolthub": {
      "command": "npx",
      "args": ["@bolthub/mcp-registry"],
      "env": {
        "LND_REST_HOST": "https://your-lnd-node:8080",
        "LND_MACAROON": "<hex-pay-macaroon>"
      }
    }
  }
}
```

That's it. Every API on bolthub.ai is now available to your agent.

### Environment Variables

The registry needs a Lightning wallet to pay for API calls. You only need **one** wallet type.

| Variable | Description |
|----------|-------------|
| `LND_REST_HOST` | **Recommended.** LND REST API URL (bolthub Node Launcher or your own node — self-hosted or via [Umbrel](https://umbrel.com)). Fast (<200ms), full control. Use a pay-scoped macaroon in production. |
| `LND_MACAROON` | Hex-encoded macaroon for LND. Required with `LND_REST_HOST`. |
| `NWC_URI` | **Recommended for easy setup.** Works with any NWC-compatible wallet: [CoinOS](https://coinos.io) (free), [Alby Hub](https://getalby.com), Zeus, Primal, and more. Slower (1-3s) but no node required. |
| `LNBITS_URL` | LNbits instance URL. Fast (<300ms). Accounts system built on any Lightning funding source. Use if you already run LNbits. |
| `LNBITS_ADMIN_KEY` | Admin API key for LNbits. Required with `LNBITS_URL`. |
| `PHOENIXD_URL` | Phoenixd HTTP API URL. Supported if you already run Phoenixd for outbound payments. |
| `PHOENIXD_PASSWORD` | HTTP password for Phoenixd. Required with `PHOENIXD_URL`. |
| `BUDGET_SATS` | Optional. Maximum sats the MCP can spend per session. When exceeded, API calls are refused. Unset = unlimited. |

### Which wallet should I use?

- **Default for production / self-hosted nodes:** LND via the bolthub **Node Launcher**, or your own LND (self-hosted or via [Umbrel](https://umbrel.com)) with a pay-scoped macaroon. Fastest and most reliable.
- **Just getting started without a node?** Use NWC with any compatible wallet like [CoinOS](https://coinos.io) (free) or [Alby Hub](https://getalby.com). Easiest to set up but slower (1-3s).

### Spending budget

Set `BUDGET_SATS` to cap total spending per session (the session lasts as long as the MCP server process runs, typically the lifetime of your Cursor or Claude Desktop window). You can also use the `--budget` CLI flag:

```bash
npx @bolthub/mcp-registry --budget 1000
```

Or via env var in your MCP config:

```json
"env": { "LND_REST_HOST": "...", "LND_MACAROON": "...", "BUDGET_SATS": "1000" }
```

**Guidance:**
- `100-500` - Testing and light use
- `1000-5000` - Typical daily development
- `10000+` - Heavy or production use
- Unset - No limit (pays any invoice as long as the wallet has funds)

The budget is a safety net against runaway spending. When the limit is reached, `call_api` returns an error instead of paying.

## Tools

The registry exposes four tools to your AI agent:

### `search_apis`

Search the bolthub marketplace for APIs by keyword or tag.

```
search_apis({ query: "weather" })
search_apis({ tag: "finance" })
search_apis()  // list all available APIs
```

### `get_api_details`

Get full details for a specific API: endpoints, pricing, examples.

```
get_api_details({ slug: "btc-intel" })
```

### `preview_cost`

Preview the cost of calling an API endpoint without making the request or paying.

```
preview_cost({ slug: "btc-intel" })
preview_cost({ slug: "btc-intel", path: "/v1/history/candles" })
```

### `call_api`

Call any API endpoint. Lightning payments are handled automatically.

```
call_api({ slug: "btc-intel", path: "/v1/history/candles", method: "GET" })
call_api({ slug: "my-api", path: "/analyze", method: "POST", body: { text: "hello" } })
```

## How it works

1. `search_apis` queries the live bolthub directory, and new APIs appear immediately
2. `get_api_details` fetches endpoint specs so the agent knows how to call them
3. `preview_cost` lets you check pricing before committing to a call
4. `call_api` hits the gateway, pays any L402 invoice automatically, and returns the response

## vs @bolthub/mcp-bridge

| | Registry (`mcp-registry`) | Bridge (`mcp-bridge`) |
|---|---|---|
| Config | One entry, every API | One entry per API |
| New APIs | Instant | Requires config change |
| Tool count | 4 (fixed) | N (one per endpoint) |
| Best for | General-purpose agents | Dedicated single-API agents |

Use the registry for most cases. Use the bridge when you want direct, named tools for a specific API.

## Security & trust

This package handles your Lightning wallet credentials, so here is exactly what it does with them:

- **Your credentials never reach bolthub.** Wallet secrets (`LND_MACAROON`, `NWC_URI`, `LNBITS_ADMIN_KEY`, `PHOENIXD_PASSWORD`) are read from env vars and passed only to the matching wallet adapter, which talks to the wallet *you* configured. They are never sent to bolthub servers, never persisted, and never logged.
- **Endpoints contacted**: `https://api.bolthub.ai` (marketplace directory), `https://<slug>.gw.bolthub.ai` (the API you call), and your configured wallet. Nothing else — no telemetry or analytics.
- **Local state**: paid L402 session tokens (not credentials) are cached in `~/.bolthub/sessions.json` with `0600` permissions, so an already-paid session is reused instead of paying again.
- **Spend control**: `BUDGET_SATS` caps spending per server process (restarting your MCP client starts a fresh session and resets the cap). Use a pay-scoped macaroon or a small dedicated wallet for defense in depth.
- **Auditable source & provenance**: the full source lives at [signaltech-org/bolthub-sdk](https://github.com/signaltech-org/bolthub-sdk) (`packages/mcp-registry`). The published `dist/index.js` is bundled from it with Bun, has zero runtime npm dependencies, and ships a source map with embedded sources. Releases are published from that repo's CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — verify with `npm audit signatures`.

## License

MIT

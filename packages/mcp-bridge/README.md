# @bolthub/mcp-bridge

MCP (Model Context Protocol) server that bridges AI agents to bolthub L402 paywalled APIs. It auto-discovers endpoints from a gateway's OpenAPI spec and handles Lightning payments transparently.

Source: [signaltech-org/bolthub-sdk](https://github.com/signaltech-org/bolthub-sdk) · Docs: [docs.bolthub.ai](https://docs.bolthub.ai/docs/sdks/mcp-bridge)

## Install

```bash
npm install -g @bolthub/mcp-bridge
```

Or use directly with `npx`:

```bash
npx @bolthub/mcp-bridge --gateway https://btc-intel.gw.bolthub.ai
```

## Configuration

Add to your MCP client config (Cursor, Claude Desktop, OpenClaw, etc.):

```json
{
  "mcpServers": {
    "btc-intel-api": {
      "command": "npx",
      "args": ["@bolthub/mcp-bridge", "--gateway", "https://btc-intel.gw.bolthub.ai"],
      "env": {
        "NWC_URI": "<your-nwc-connection-string>"
      }
    }
  }
}
```

### Environment Variables

The bridge supports multiple wallet types. You only need **one**.

| Variable | Description |
|----------|-------------|
| `LND_REST_HOST` | **Recommended.** LND REST API URL (e.g. from the bolthub Node Launcher or `https://your-node:8080`). Fast (<200ms), self-hosted, full control. Use a pay-scoped macaroon in production. |
| `LND_MACAROON` | Hex-encoded macaroon for LND. Required when using `LND_REST_HOST`. |
| `NWC_URI` | **Recommended for easy setup.** Works with any NWC-compatible wallet: CoinOS (free), Alby Hub, Zeus, Primal, and more. Slower (1-3s) but no node required. |
| `LNBITS_URL` | LNbits instance URL. Fast (<300ms). Accounts system built on any Lightning funding source. Use if you already run LNbits. |
| `LNBITS_ADMIN_KEY` | Admin API key for LNbits. Required when using `LNBITS_URL`. |
| `PHOENIXD_URL` | Phoenixd HTTP API URL. Supported if you already run Phoenixd for outbound payments. |
| `PHOENIXD_PASSWORD` | HTTP password for Phoenixd. Required when using `PHOENIXD_URL`. |
| `BUDGET_SATS` | Optional. Maximum sats the MCP can spend per session. When exceeded, API calls are refused. Unset = unlimited. |

**Priority order:** If multiple wallet types are configured, the bridge uses the first available: LND > NWC > LNbits > Phoenixd.

### Which wallet should I use?

- **Default for production / self-hosted nodes:** LND via the bolthub **Node Launcher**, or your own LND (self-hosted or via [Umbrel](https://umbrel.com)) with a pay-scoped macaroon. Fastest and most reliable.
- **Just getting started without a node?** Use NWC with any compatible wallet like [CoinOS](https://coinos.io) (free) or [Alby Hub](https://getalby.com). Easiest to set up but slower (1-3s).

### Spending budget

Set `BUDGET_SATS` to cap total spending per session, or use `--budget`:

```bash
npx @bolthub/mcp-bridge --gateway https://btc-intel.gw.bolthub.ai --budget 1000
```

Guidance: `100–500` for testing, `1000–5000` for daily dev, `10000+` for production. Unset = no limit.

## Alternatives

This bridge is one way to give agents L402 payment capabilities. There are also third-party MCPs that handle Lightning payments:

- **[Alby MCP](https://getalby.com/blog/alby-bitcoin-payments-mcp-server)** -- Recommended for most users. Uses NWC under the hood. Works with any Alby Hub or CoinOS wallet.
- **[Fewsats MCP](https://github.com/Fewsats/fewsats-mcp)** -- Zero-config custodial option. Single API key, no Lightning node needed.

For more options, see the [Start Earning guide](https://bolthub.ai/start-earning).

## How it works

1. On startup, fetches the gateway's OpenAPI spec from `/.well-known/openapi.json`
2. Converts each API endpoint into an MCP tool with proper `inputSchema`
3. When an agent calls a tool, makes the HTTP request to the gateway
4. If the gateway returns 402 (Payment Required), automatically pays the Lightning invoice and retries
5. Returns the API response to the agent

## SDKs

For building custom agents without MCP, use our SDKs directly:

- **TypeScript:** `npm install @bolthub/agent`
- **Python:** `pip install bolthub`

## Receipt Required (opt-in)

By default, every discovered tool auto-pays its L402 invoice with only `BUDGET_SATS` as a guard — a numeric cap, not a human decision. For high-value or irreversible spends you can **opt in** to also requiring a verifiable *authorization receipt*: proof a named human approved this exact tool at this price, before any sats move.

This is **off by default and fully backward-compatible** — with no manifest configured, tool handlers are registered exactly as before. To enable it, point `BOLTHUB_AGENT_ACTIONS` at an [Action Risk Manifest](./agent-actions.example.json) listing which tools need a receipt:

```bash
BOLTHUB_AGENT_ACTIONS=./agent-actions.json \
  npx @bolthub/mcp-bridge --gateway https://btc-intel.gw.bolthub.ai
```

For a tool marked `receipt_required`, the bridge gates its payment:

| Check | Behavior |
|---|---|
| Missing receipt | `428 Receipt Required` (refused — no payment) |
| Valid receipt | the tool runs, the invoice is paid, receipt is one-time consumed |
| Replayed receipt | refused (one-time consumption — see store note) |
| Forged / wrong tool or amount | refused (signature / action-binding fails) |

The agent presents the receipt in the tool args as `_emilia_receipt` (and `_emilia_amount_sats` for the price it was issued for). The receipt is bound to the **exact tool and price ceiling**, so an approval for one tool/amount can't authorize a different tool or a larger payment. Tools *not* listed pass straight through, unchanged.

> **Replay scope:** one-time consumption holds within the configured store. The **default store is process-local (in-memory)** — it does *not* survive a restart or span multiple bridge instances. For durable / multi-instance replay protection, pass a durable `store` ({ has, add }) to the gate (Redis/DB).

Verification is offline — no API key, no account, no bolthub or EMILIA server trusted. It runs the open reference verifier in [`@emilia-protocol/require-receipt`](https://www.npmjs.com/package/@emilia-protocol/require-receipt) (Apache-2.0). This is *not* auth or permissions; it's portable accountability evidence the operator keeps for their own liability — a *necessary, not sufficient* condition. Spec: IETF Internet-Draft `draft-schrock-ep-authorization-receipts`. Background and the four-check conformance report (RR-1): [Fire Drill report](https://www.emiliaprotocol.ai/fire-drill/report/signaltech-bolthub-sdk).

> **Secure by default:** the gate will **not** accept a self-signed (inline-key) receipt for an L402 payment by default. Pin the issuer key(s) you trust via `BOLTHUB_RECEIPT_TRUSTED_KEYS` (comma-separated base64url SPKI). With `receipt_required` enabled and no trusted key configured, the gate **fails closed** — the payment is refused (`receipt_enforcement_misconfigured`), never made under an untrusted key. `BOLTHUB_RECEIPT_ALLOW_INLINE_KEY=1` re-enables inline keys for **non-production demos only**.

## Security & trust

This package handles your Lightning wallet credentials, so here is exactly what it does with them:

- **Your credentials never reach bolthub.** Wallet secrets (`LND_MACAROON`, `NWC_URI`, `LNBITS_ADMIN_KEY`, `PHOENIXD_PASSWORD`) are read from env vars and passed only to the matching wallet adapter, which talks to the wallet *you* configured. They are never sent to bolthub servers, never persisted, and never logged.
- **Endpoints contacted**: the gateway you pass via `--gateway` and your configured wallet. Nothing else — no telemetry or analytics.
- **Local state**: paid L402 session tokens (not credentials) are cached in `~/.bolthub/sessions.json` with `0600` permissions, so an already-paid session is reused instead of paying again.
- **Spend control**: `BUDGET_SATS` caps spending per server process (restarting your MCP client starts a fresh session and resets the cap). Use a pay-scoped macaroon or a small dedicated wallet for defense in depth.
- **Auditable source & provenance**: the full source lives at [signaltech-org/bolthub-sdk](https://github.com/signaltech-org/bolthub-sdk) (`packages/mcp-bridge`). The published `dist/index.js` is bundled from it with Bun, has zero runtime npm dependencies, and ships a source map with embedded sources. Releases are published from that repo's CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — verify with `npm audit signatures`.

## License

MIT

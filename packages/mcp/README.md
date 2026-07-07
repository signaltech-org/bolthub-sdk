# @bolthub/mcp

The bolthub MCP server. **One entry** in your MCP client config; behind it, three kinds of tool source sharing one wallet and one Lightning budget:

- **The bolthub marketplace** — search, inspect, and call every listed API (`search_apis`, `get_api_details`, `preview_cost`, `call_api`, plus the Node Launcher tools).
- **Specific L402 gateways** — a gateway's OpenAPI endpoints become directly-named tools.
- **Your other MCP servers** — local or remote, proxied transparently: free tools pass straight through; a tool that answers with an L402 payment challenge is paid inside your budget and retried.

Replaces `@bolthub/mcp-registry` and `@bolthub/mcp-bridge` (both deprecated — migration below).

Source: [signaltech-org/bolthub-sdk](https://github.com/signaltech-org/bolthub-sdk) · Docs: [docs.bolthub.ai](https://docs.bolthub.ai/docs/sdks/mcp)

## Quick start

Add to your MCP client config (Cursor, Claude Desktop, OpenClaw, etc.):

```json
{
  "mcpServers": {
    "bolthub": {
      "command": "npx",
      "args": ["-y", "@bolthub/mcp"],
      "env": { "NWC_URI": "<your-nwc-connection-string>" }
    }
  }
}
```

With no config file this runs in **marketplace mode**: every listed bolthub API is available to your agent through the meta-tools. New listings appear automatically; no config changes, ever.

## The full setup: one config file

`~/.bolthub/mcp.json` — the `mcpServers` block is the exact shape your MCP client already uses, so paste your existing entries in wholesale:

```jsonc
{
  "marketplace": true,
  "gateways": ["https://btc-intel.gw.bolthub.ai"],
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"]
    },
    "remote-tools": {
      "url": "https://tools.example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  },
  "budget":     { "sat": 10000 },   // lifetime ceiling for this run, ALL sources combined
  "maxPerCall": { "sat": 500 },     // per-call ceiling
  "namespace":  "prefix",           // "prefix" (default) or "flat"
  "telemetry":  false               // reserved; v1 sends nothing anywhere
}
```

Then point the client at it:

```json
{
  "mcpServers": {
    "bolthub": {
      "command": "npx",
      "args": ["-y", "@bolthub/mcp", "--config", "~/.bolthub/mcp.json"],
      "env": { "PHOENIXD_URL": "…", "PHOENIXD_PASSWORD": "…" }
    }
  }
}
```

### What the agent sees

- Marketplace meta-tools, unprefixed: `search_apis`, `get_api_details`, `preview_cost`, `call_api`, `deploy_node`, `node_status`.
- Gateway endpoints, prefixed by gateway slug: `btc-intel__get_v1_history_candles`, ….
- Downstream MCP tools, prefixed by their config key: `filesystem__read_file`, ….

Two servers can both expose a `search` tool — prefixing keeps them apart. `namespace: "flat"` passes bare names through instead and **fails at startup on any collision** (a tool is never silently shadowed).

## Wallet (optional)

Set ONE of these in the server's `env`:

```
PHOENIXD_URL + PHOENIXD_PASSWORD     (recommended, fast <200ms)
LND_REST_HOST + LND_MACAROON         (fastest, <200ms)
LNBITS_URL + LNBITS_ADMIN_KEY        (fast, <300ms)
NWC_URI                              (easiest, but slower 1-3s)
```

No wallet is not an error: free tools and marketplace search keep working; paid calls return their payment challenge with a setup hint.

## One budget, hard guarantee

`budget.sat` caps what the server can spend over its lifetime — across gateway calls, `call_api`, and paid downstream MCP tools **combined**. Reservations are synchronous, so concurrent calls on different sources can't jointly overspend. `budget.sat: 0` is valid and means "free tools only". The agent can never lift the ceiling; refusals come back as clean "Payment refused" results.

Every payment logs one line to **stderr** (your local audit trail). The `telemetry` flag is reserved: v1 sends nothing anywhere, on or off; if a future version adds an opt-in ingest it will carry `{ scheme, asset, amount }` only — no tool arguments, no resource identity.

## Migrating from @bolthub/mcp-registry / @bolthub/mcp-bridge

| Before | After |
|---|---|
| `npx @bolthub/mcp-registry` | `npx @bolthub/mcp` (zero config = same behavior) |
| `npx @bolthub/mcp-registry --api-url <url>` | `npx @bolthub/mcp --api-url <url>` |
| `npx @bolthub/mcp-bridge --gateway <url>` | `npx @bolthub/mcp --gateway <url>` |
| `--budget` / `BUDGET_SATS` | unchanged (now a single pool across all sources) |
| gateway tool `btc-intel_get_v1_x` | `btc-intel__get_v1_x` (double-underscore namespace) |

**Remove** the old entries from your client config rather than stacking them next to this one — a nested bolthub bin inside `mcpServers` would pay from its own wallet env, invisible to the shared budget (the server warns at startup if it spots this).

## Notes & limits (v1)

- Proxies MCP **tools** only — no resources, prompts, or sampling passthrough yet.
- The downstream tool list is snapshotted at startup; hot add/remove needs a restart.
- A downstream that fails to start is skipped with a stderr warning; the rest keep serving.
- Everything logs to stderr, never stdout (stdout is the MCP channel).

## License

MIT

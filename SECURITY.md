# Security

## Reporting a vulnerability

Email **contact@bolthub.ai**. We respond within one business day. Please do not file public GitHub issues for security bugs.

## Trust model

These packages handle Lightning wallet credentials, so here is exactly what they do with them:

- **Credentials come only from your environment** (`LND_MACAROON`, `NWC_URI`, `LNBITS_ADMIN_KEY`, `PHOENIXD_PASSWORD`). They are passed to the matching wallet adapter in `packages/agent/src/wallets/` and used solely to call the wallet *you* configured (your LND node, your LNbits instance, your Phoenixd, or your NWC relay). They are never sent to bolthub servers, never written to disk, and never logged.
- **Network surface** of the MCP servers and CLI: `https://api.bolthub.ai` (marketplace directory), `https://<slug>.gw.bolthub.ai` (the API endpoint you choose to call), and your configured wallet. There is no telemetry, analytics, or other phone-home of any kind.
- **Local state**: paid L402 session tokens (not credentials) are cached in `~/.bolthub/sessions.json`, written atomically with `0600` permissions, so an already-paid session can be reused instead of paying again.
- **Spend control**: `BUDGET_SATS` caps total spend per server process. When the cap is reached, `call_api` returns an error instead of paying. For defense in depth, use a pay-scoped macaroon or a small dedicated wallet.

## Supply chain

- Releases are published by [GitHub Actions in this repository](.github/workflows/publish.yml) with **npm provenance** — verify with `npm audit signatures` or via the "Provenance" section on the npm package page.
- The published bundles have **zero runtime npm dependencies**: Bun compiles each package and its in-repo imports into a single `dist/index.js`, with a source map (including embedded sources) alongside it.
- PyPI releases are published via [Trusted Publishing](https://docs.pypi.org/trusted-publishers/) with PEP 740 attestations.

Platform-level security (gateway, node launcher, billing) is documented at [bolthub.ai/security](https://bolthub.ai/security).

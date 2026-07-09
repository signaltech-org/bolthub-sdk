# bolthub SDK

Source code for every publicly published [bolthub.ai](https://bolthub.ai) package: the npm `@bolthub/*` scope and the `bolthub` / `bolthub-verify` PyPI packages.

bolthub is a payment layer for agent-to-tool commerce: charge agents for your MCP tools and APIs per call, settling straight to your wallet over Lightning (L402), with bolthub never in the funds path. These packages are the open-source side of that: the tool-payment SDK, payment clients, MCP servers, a CLI, and origin-verification middleware.

| Package | Registry | Directory | What it is |
| --- | --- | --- | --- |
| [`@bolthub/pay`](https://www.npmjs.com/package/@bolthub/pay) | npm | `packages/pay` | The payments SDK, both sides: price an MCP tool or HTTP endpoint (`createPaywall`), pay for tools within a budget (`ToolClient` for MCP, `L402Client` for HTTP), wallet adapters (LND, LNbits, Phoenixd, NWC, WebLN); rails: L402, facilitator. Zero runtime dependencies |
| [`@bolthub/mcp`](https://www.npmjs.com/package/@bolthub/mcp) | npm | `packages/mcp` | The bolthub MCP server: marketplace + specific gateways + your other MCP servers behind one config entry, with one shared Lightning budget |
| [`@bolthub/cli`](https://www.npmjs.com/package/@bolthub/cli) | npm | `packages/cli` | Terminal client for the marketplace |
| [`@bolthub/verify`](https://www.npmjs.com/package/@bolthub/verify) | npm | `packages/verify` | Gateway signature verification middleware (Express/Fastify/Node) |
| [`bolthub`](https://pypi.org/project/bolthub/) | PyPI | `packages/agent-python` | The payments SDK in Python: L402 client + wallets, and the seller-side paywall |
| [`bolthub-verify`](https://pypi.org/project/bolthub-verify/) | PyPI | `packages/verify-python` | Python gateway signature verification (Flask/Django/FastAPI) |

`packages/shared` is internal (never published); it is here because `@bolthub/mcp` bundles it.

> **Consolidation (2026-07):** `@bolthub/agent` merged into `@bolthub/pay` (≥0.4.0); `@bolthub/mcp-registry` and `@bolthub/mcp-bridge` merged into `@bolthub/mcp`. The old names are deprecated on npm and point here.

## Relationship to the bolthub platform

The bolthub platform (gateway, API, web app) lives in a private monorepo. The SDK packages above are developed there and synced to this repository, which is the **publish origin**: releases are tagged here and built + published by [CI](.github/workflows/publish.yml) with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so what's on npm is verifiably built from this public source.

Issues and PRs are welcome here, but note that this repo is a generated mirror: PRs are never merged directly. Accepted changes are applied to the monorepo first (with attribution), then sync back out with the next release. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Verifying what you install

Published `dist/` bundles are built with Bun from this source and ship source maps with embedded sources, so the tarball itself is readable.

```bash
# provenance: confirm the tarball was built from this repo by GitHub Actions
npm audit signatures

# or rebuild and compare yourself
git clone https://github.com/signaltech-org/bolthub-sdk
cd bolthub-sdk && bun install
cd packages/mcp && bun run build
```

See [SECURITY.md](SECURITY.md) for the trust model (what touches your wallet credentials and what doesn't) and how to report vulnerabilities.

## Development

```bash
bun install
bun test
```

Each TypeScript package builds with `bun run build` from its directory (`@bolthub/pay` must be built before the packages that bundle it).

## License

MIT

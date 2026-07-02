# bolthub SDK

Source code for every publicly published [bolthub.ai](https://bolthub.ai) package — the npm `@bolthub/*` scope and the `bolthub` / `bolthub-verify` PyPI packages.

bolthub is a payment layer for agent-to-tool commerce: charge agents for your MCP tools and APIs per call, settling on the rail you choose (Lightning today, stablecoins next), with bolthub never in the funds path. These packages are the open-source side of that: the tool-payment SDK, payment clients, MCP servers, a CLI, and origin-verification middleware.

| Package | Registry | Directory | What it is |
| --- | --- | --- | --- |
| [`@bolthub/pay`](https://www.npmjs.com/package/@bolthub/pay) | npm | `packages/pay` | Tool-payment SDK — price an MCP tool or HTTP endpoint (`createPaywall`), pay for tools within a budget (`PayingClient`); rails: L402, x402, facilitator |
| [`@bolthub/agent`](https://www.npmjs.com/package/@bolthub/agent) | npm | `packages/agent` | L402 payment client — wallet adapters (LND, LNbits, Phoenixd, NWC, WebLN), 402 challenge handling, session cache |
| [`@bolthub/mcp-registry`](https://www.npmjs.com/package/@bolthub/mcp-registry) | npm | `packages/mcp-registry` | MCP server exposing the whole bolthub marketplace to AI agents |
| [`@bolthub/mcp-bridge`](https://www.npmjs.com/package/@bolthub/mcp-bridge) | npm | `packages/mcp-bridge` | MCP server for a single bolthub gateway (one tool per endpoint) |
| [`@bolthub/cli`](https://www.npmjs.com/package/@bolthub/cli) | npm | `packages/cli` | Terminal client for the marketplace |
| [`@bolthub/verify`](https://www.npmjs.com/package/@bolthub/verify) | npm | `packages/verify` | Gateway signature verification middleware (Express/Fastify/Node) |
| [`bolthub`](https://pypi.org/project/bolthub/) | PyPI | `packages/agent-python` | Python L402 client |
| [`bolthub-verify`](https://pypi.org/project/bolthub-verify/) | PyPI | `packages/verify-python` | Python gateway signature verification (Flask/Django/FastAPI) |

`packages/shared` is internal (never published); it is here because `@bolthub/mcp-bridge` bundles it.

## Relationship to the bolthub platform

The bolthub platform (gateway, API, web app) lives in a private monorepo. The SDK packages above are developed there and synced to this repository, which is the **publish origin**: releases are tagged here and built + published by [CI](.github/workflows/publish.yml) with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so what's on npm is verifiably built from this public source.

Issues and PRs are welcome here. Accepted changes are applied to the monorepo first, then sync back out with the next release.

## Verifying what you install

Published `dist/` bundles are built with Bun from this source and ship source maps with embedded sources, so the tarball itself is readable.

```bash
# provenance: confirm the tarball was built from this repo by GitHub Actions
npm audit signatures

# or rebuild and compare yourself
git clone https://github.com/signaltech-org/bolthub-sdk
cd bolthub-sdk && bun install
cd packages/mcp-registry && bun run build
```

See [SECURITY.md](SECURITY.md) for the trust model (what touches your wallet credentials and what doesn't) and how to report vulnerabilities.

## Development

```bash
bun install
bun test
```

Each TypeScript package builds with `bun run build` from its directory (`@bolthub/agent` must be built before the packages that bundle it).

## License

MIT

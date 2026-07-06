# Changelog

All notable changes to `@bolthub/pay` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-06

### Removed

- **BREAKING: removed the x402 (stablecoin) rail; `@bolthub/pay` is now
  Lightning-only (L402).** Removed exports: `x402Rail`, `x402Payer`,
  `x402Facilitator`, `eip3009Signer`, and the x402 types (`X402Rail`,
  `X402RailOptions`, `FacilitatorClient`, `X402Requirements`,
  `X402PaymentPayload`, `X402FacilitatorOptions`, `Eip3009SignerOptions`,
  `Eip712Account`, `X402PayerOptions`, `X402Signer`). After evaluating x402's
  on-chain settlement and gas costs for micropayments, we are standardising on
  the Lightning Network. The `PaymentRail` interface stays rail-agnostic, so a
  rail can still be added by implementing it.

### Changed

- **`PayingClient` is now `ToolClient`** (with `ToolClientOptions`). The old
  names remain as deprecated aliases until 1.0. Rationale: the client's job is
  calling tools safely — free tools pass through untouched; paying, within the
  budget you set, is one property of that.

## [0.2.0] - 2026-07-02

### Added

- **Concrete x402 adapters** — the two halves that were injected interfaces in
  0.1.0 now ship in the package, still with zero on-chain dependencies:
  - `x402Facilitator({ url, headers?, authHeaders? })`: a `FacilitatorClient`
    speaking the standard x402 facilitator HTTP API (`/verify`, `/settle`).
    Works with the reference `x402.org/facilitator` (Base Sepolia), Coinbase
    CDP (pass auth headers), or a self-hosted facilitator. Transport failures
    degrade to invalid/failed results instead of throwing.
  - `eip3009Signer({ account })`: an `X402Signer` that builds the EIP-3009
    `TransferWithAuthorization` EIP-712 typed data and delegates signing to
    any viem-`LocalAccount`-shaped account (`{ address, signTypedData }`).
    Ships chain-id mappings for the common x402 networks plus a `chainIds`
    override.
- Wire-format verified live against `https://x402.org/facilitator`: a signed
  payload round-trips verify with the payer address correctly recovered
  (rejected only for the throwaway key's empty balance, as expected).

### Known limitations

- A live settle (funded testnet/mainnet USDC) has not been exercised yet.
- x402 remains SDK-only: bolthub's hosted facilitator still settles Lightning
  (L402) only.

## [0.1.0] - 2026-07-02

First public release.

### Added

- **Seller side**: `createPaywall({ rails })` wraps an MCP tool (or a handler
  directly) so an unpaid call returns a `payment_required` challenge and the
  handler runs only once a valid proof verifies. Multi-asset pricing offers
  one challenge with an offer per rail.
- **Rails**: `l402Rail` (Lightning/L402 — HMAC-signed, resource-scoped,
  time-limited tokens; constant-time verification), `x402Rail` (stablecoin —
  advertises x402 payment requirements and delegates verify/settle to an
  injected facilitator), and `facilitatorRail`/`httpFacilitator` (delegate
  mint/verify to a bolthub facilitator, e.g. the hosted one).
- **Buyer side**: `PayingClient` calls a tool, pays a challenge offer with the
  first matching payer (`l402Payer`, `x402Payer`), and retries transparently,
  under a per-asset `maxTotal` budget.
- **Price advertisement**: `pay.advertise(price)` emits the discovery envelope
  so cost-aware agents can budget before calling.
- Ships the [Tool Payment Profile v0.1 (draft)](./docs/tool-payment-profile-v0.md)
  spec the wire format implements.

### Known limitations

- The wire format (TPP `0.1`) is a draft and may evolve before 1.0; breaking
  changes bump the minor version while the package is 0.x.
- Self-hosted `l402Rail` has no built-in replay dedup — a paid proof stays
  valid for the token TTL. Use the facilitator rail (at-most-once redemption)
  when you need strict per-call billing.
- No bundled NWC invoice provider or hosted-x402 signer adapter yet; both are
  injected interfaces today.

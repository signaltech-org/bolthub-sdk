# Changelog

All notable changes to `@bolthub/pay` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

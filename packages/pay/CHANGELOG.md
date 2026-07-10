# Changelog

All notable changes to `@bolthub/pay` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-07-10

### Added

- **Prepaid credit (cross-endpoint, face-value).** `L402Client.buyCredit(url,
  creditSats, opts)` pays once for a sats budget spendable across ALL of one
  provider's `per_request` endpoints; subsequent calls to that provider's host
  draw the budget with no further payment. `batchFetch(urls, { creditSats })`
  groups URLs by provider and buys one credit per provider (N providers = N
  payments, never a pooled balance — non-custodial). `clearCredits()` manages
  the per-host credential cache. Credit is face-value (no discount); `buyCredit`
  verifies the server echoed the requested budget before the wallet is touched.
- **Delegation re-homed onto credit.** `getCreditCredential(url)` /
  `dropCreditCredential(url)` expose the held credit credential for a provider,
  so `attenuate()` (and the MCP `mint_scoped_token`) narrows a credit token into
  a scoped child. The retired bundle credential store and its accessors
  (`getBundleCredential`/`dropBundleCredential`/`clearBundles`) are removed.

## [0.6.0] - 2026-07-10

### Removed

- **BREAKING: prepaid bundles are retired.** `buyBundle` is now a deprecated
  stub that throws and pays nothing; the request path no longer presents a
  cached bundle credential, and the `X-Bolthub-Bundle` flow is gone. Use
  per-call payment, or prepaid credit for cross-endpoint prepayment when it
  lands. Rationale: bundles duplicated the `token_bucket` pricing model and the
  cross-endpoint prepaid-credit concept. Scoped delegation (`attenuate`) and the
  grant-backed credential store are unchanged.

## [0.5.1] - 2026-07-10

### Changed

- Docs: the README now documents `buyBundle`, receipts (`exportReceipts` /
  `FileReceiptStore`), and free retries on origin failure, and lists the wallet
  adapters LND-first (LND recommended, NWC convenient). No API changes.

## [0.5.0] - 2026-07-10

### Added

- **Prepaid bundles.** `L402Client.buyBundle(url, uses, opts)` pays one invoice
  for an N-use credential; subsequent `request`/`get`/`post` calls to that URL
  spend it down with no further payment until it 402s, then fall through to the
  normal flow. Budget and `maxCostSats` are enforced on the purchase.
  `getBundleCredential` / `dropBundleCredential` / `clearBundles` manage the
  cached credential.
- **`attenuate()` v2.** New tighten-only options `nUses`, `maxSats`, and
  `pathPrefix` (in addition to `method`/`validUntil`), validated against the
  credential's existing caveats so a child can never widen scope. Mirrors the
  gateway verifier's folds.
- **Delegation budget interlock.** `Budget.reserveTotal` and
  `L402Client.reserveDelegatedCap` / `rollbackDelegatedCap` reserve a child's
  spend cap from the parent budget at mint (== remaining accepted, +1 refused).
- **Payment-status / free retries.** `readPaymentStatus` parses the
  `X-Bolthub-Payment` headers; `L402Client` auto-retries free-retryable upstream
  failures (5xx/429/408/unreachable) with jittered backoff (opt out with
  `retryOnUpstreamFailure: false`), and a typed `UpstreamFailedError` is
  available via `throwOnUpstreamFailure`.
- **Payment receipts.** `ReceiptStore` (in-memory + `FileReceiptStore`),
  `onPaid` enriched with preimage/invoice/payment_hash, `exportReceipts`
  (JSON/CSV, redactable), and dependency-free offline `verifyReceipt`.

## [0.4.0] - 2026-07-07

### Added

- **`@bolthub/agent` merged in: `@bolthub/pay` is now the whole payments SDK,
  both sides of the sale.** New exports, previously published as
  `@bolthub/agent` (now deprecated): the HTTP buyer client `L402Client`
  (+ `createL402Client`, `L402Error`, `L402BudgetError`, `L402TimeoutError`,
  `L402PaymentError`), the wallet adapters (`LndWallet`, `LnbitsWallet`,
  `PhoenixdWallet`, `NwcWallet`, `WebLnWallet`, `isWebLnAvailable`),
  `FileSessionStore`, and macaroon `attenuate`. The package stays
  zero-runtime-dependency and gains `@bolthub/agent`'s browser entry
  (`browser` export condition).
- **`Budget`** — the per-asset reserve/rollback accounting extracted from
  `ToolClient`, now shareable: pass one instance as `ToolClientOptions.budget`
  and `L402ClientOptions.budget` and the MCP-wire and HTTP-402 payment paths
  draw from a single pool (`maxTotal`/`maxPerCall` per asset).
- **`L402Client` options `budget` and `onPaid`**, and a per-request
  `maxCostSats` on `L402RequestOptions` that tightens the per-request cap for
  one call.
- **`walletFromEnv()`** — the standard env-var → wallet mapping
  (`LND_REST_HOST`/`LND_MACAROON`, `LNBITS_URL`/`LNBITS_ADMIN_KEY`,
  `PHOENIXD_URL`/`PHOENIXD_PASSWORD`, `NWC_URI`), previously copy-pasted
  across the cli/mcp-bridge/mcp-registry bins. Returns `undefined` when no
  wallet is configured; NWC requires an injected `nwcConnect` factory (e.g.
  backed by `@getalby/sdk`) since this package ships no NWC protocol
  implementation.
- `WalletAdapter` gained an optional `close()` for adapters that hold a
  connection open (NWC relay sockets).

### Changed

- `L402PayerWallet` is now a type alias of `WalletAdapter` (they were always
  structurally identical).

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

# Changelog

All notable changes to `@bolthub/agent` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-06-26

### Fixed

- **`attenuate()` no longer throws on real L402 macaroons.** Every macaroon the
  bolthub gateway mints carries four binding caveats (payment_hash, tenant_id,
  endpoint_id, expires_at). On a macaroon with that many fields, the bundled
  `macaroon` library's `exportBinary()` overflowed — its internal byte buffer
  never initialised a capacity, so it doubled on every append until it exceeded
  the maximum array size (`RangeError: length too large`). 0.3.0's `attenuate()`
  therefore failed on every real token. We now serialise the v2 binary ourselves
  from the library's public byte getters; the signature chaining is unchanged.
  Verified end to end against the production gateway (a delegated, attenuated
  call returns data; method and valid_until caveats are enforced).

## [0.3.0] - 2026-06-26

### Added

- **`attenuate(macaroon, opts)`** for offline delegation: narrow an L402
  macaroon by appending `method` and/or `validUntil` first-party caveats, so a
  parent agent can hand a sub-agent a restricted credential without re-paying.
  The `macaroon` package is bundled at build time, so the SDK keeps zero runtime
  dependencies.

## [0.2.0] - 2026-06-20

### Fixed

- **Budget can no longer be bypassed by a price-less `402`.** Previously a `402`
  with no `amountSats` in its body skipped the per-request and total-budget
  checks entirely and the invoice was paid blind and uncounted. The price is now
  resolved from all available sources — the body `amountSats`, the BOLT11
  invoice itself (decoded from the `WWW-Authenticate` header, dependency-free),
  and an optional `priceHeader` — and a configurable `onUnknownAmount` policy
  governs the rare case where the price still cannot be determined. The default
  (`"cap"`) pays only up to `maxPerRequestSats` (counted against the budget) and
  refuses outright when no ceiling is set, so a price-less challenge is never
  paid blind. **Behaviour change:** a price-less `402` that previously paid
  blind now refuses by default; set `onUnknownAmount: "allow"` to restore the
  old behaviour.
- **Concurrent requests can no longer overspend the budget.** The budget check
  and the spend increment previously straddled the payment `await`, so
  concurrent requests on one client (e.g. via `Promise.all`) could both pass the
  check and overspend. The charge is now reserved synchronously before the
  await (and rolled back if payment fails), so `totalSpent` stays exact and the
  budget is never exceeded.
- **`FileSessionStore` no longer silently swallows write failures.** `persist`
  caught and discarded errors from the atomic write/rename, so `set`/`delete`/
  `clear` reported success even when the disk write failed. The error is now
  re-thrown after the temp file is cleaned up.

### Added

- `onUnknownAmount` (`"cap"` | `"refuse"` | `"allow"`, default `"cap"`) and
  `priceHeader` options on `L402Client`.

# Changelog

All notable changes to the `bolthub` Python SDK are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-26

### Added

- **`attenuate(macaroon, *, method=, valid_until=)`** for offline delegation:
  narrow an L402 macaroon by appending `method` and/or `valid_until` first-party
  caveats, so a parent agent can hand a sub-agent a restricted credential
  without re-paying. Needs the new optional dependency:
  `pip install bolthub[delegation]`.

## [0.2.1] - 2026-06-22

### Fixed

- **`L402Auth` now buffers the request body and reads the 402 challenge body
  explicitly.** The `requires_request_body` / `requires_response_body` class
  flags were inert: httpx consults them only in the base auth-flow methods,
  which `L402Auth` overrides. As a result a body-supplied `amountSats` could be
  missed, and a streaming retry relied on incidental behaviour. The sync and
  async flows now call `request.read()` / `await request.aread()`, and read
  only the 402 response, leaving the post-payment response untouched. A
  streaming `client.stream("GET", ...)` is therefore replayed after the 402 and
  delivered incrementally (the flow used for paywalled SSE / `time_pass`
  streams).

## [0.2.0] - 2026-06-20

### Added

- **`NwcWallet.from_uri(...)` and `AsyncNwcWallet.from_uri(...)`** — configure a
  Nostr Wallet Connect wallet directly from a
  `nostr+walletconnect://<pubkey>?relay=<wss>&secret=<hex>` connection URI (the
  one wallet that previously could not be wired from an env var). Implements
  NIP-47 `pay_invoice` (kind 23194/23195) over the relay websocket with NIP-04
  encryption and BIP-340 event signing, including timeout handling and error
  mapping to `L402Error`. Lives behind the optional `bolthub[nwc]` extra
  (`websockets` + `cryptography`), lazily imported with an actionable error when
  absent; BIP-340 signing is vendored in pure Python, so no native secp256k1
  build is required. The existing `NwcWallet(pay_fn=...)` constructor is
  unchanged.
- **`AsyncL402Client`** — an async-native client built on `httpx.AsyncClient`,
  mirroring `L402Client`'s constructor and session/budget semantics with
  `async def request/get/post` and `async with` support. Adds an
  `AsyncWalletAdapter` protocol and async `AsyncLndWallet` / `AsyncLnbitsWallet`
  / `AsyncPhoenixdWallet` adapters, plus `SyncWalletAdapter`, which runs an
  existing synchronous wallet's `pay_invoice` in a worker thread. A sync wallet
  passed to `AsyncL402Client` is auto-wrapped, so existing wallets work
  unchanged under the async client. Async hosts no longer need to bridge the
  sync client through `asyncio.to_thread` and an external lock.
- **`L402Auth(httpx.Auth)`** — drop the L402 payment flow into your own
  `httpx.Client` / `httpx.AsyncClient` (your transport, pooling, and retries)
  instead of using the SDK-owned client: `httpx.Client(auth=L402Auth(wallet,
  budget_sats=...))`. Implements both `sync_auth_flow` and `async_auth_flow`,
  enforces the same budget / session / unknown-amount semantics as `L402Client`,
  and pays a sync wallet from the async flow in a worker thread so it never
  blocks the event loop. `InMemorySessionStore` is now also exported from the
  top-level `bolthub` package.

### Fixed

- **`FileSessionStore` no longer masks errors or leaks temp files on a failed
  write.** When `os.rename` failed during an atomic persist, the cleanup branch
  called `os.get_inheritable` on an already-closed file descriptor, which raised
  `OSError: Bad file descriptor` — masking the real error and leaving the temp
  file behind. Persist now uses deterministic cleanup: the fd is closed exactly
  once, a leftover temp file is always unlinked, and the original exception
  propagates so a failed write is no longer silently swallowed.
- **`L402Client` is now thread-safe.** Budget accounting previously read and
  mutated `total_spent` with no synchronization, so concurrent requests (e.g.
  from a thread pool) could both pass the budget check and overspend. Accounting
  now uses an internal lock with a reserve/rollback model: the budget is always
  exact and never exceeded under concurrency. The lock is held only around the
  budget check (never across the network or payment), so requests still run in
  parallel. `InMemorySessionStore` is now thread-safe as well.


- **Budget can no longer be bypassed by a price-less `402`.** Previously, when a
  `402` response carried no `amountSats` in its JSON body, the per-request and
  total-budget checks were skipped and the invoice was paid blind and uncounted.
  The price is now resolved from all available sources — the body `amountSats`,
  the BOLT11 invoice itself (decoded from the `WWW-Authenticate` header,
  dependency-free), and an optional `price_header` — and a configurable
  `on_unknown_amount` policy governs the rare case where the price still cannot
  be determined. The default (`"cap"`) pays only up to `max_per_request_sats`
  (counted against the budget) and refuses outright when no ceiling is set, so a
  price-less challenge is never paid blind.

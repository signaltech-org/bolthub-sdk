# Contributing

Thanks for your interest in improving the bolthub SDKs. Issues and PRs are
welcome here, but this repository works differently from most, so please read
this first. It will save you time.

## How this repository works

This repo is a **generated mirror** and the **publish origin**, not the
development tree. The packages are developed in a private monorepo alongside
the bolthub platform and synced here by a script that overwrites the mirror's
contents (`rsync --delete`). Releases are tagged here so CI can publish to npm
with provenance and to PyPI via Trusted Publishing, verifiably from this public
source.

The practical consequence: **PRs are never merged into this repo directly.**
Anything merged here would be silently overwritten by the next sync. That is a
property of the setup, not a judgement of your change.

## How to contribute anyway

- **Bugs and small fixes:** open an issue, or a PR if the fix is easiest to
  express as code. If we accept it, we apply the change in the monorepo with
  attribution (`Co-authored-by:` you), close the PR with a pointer to the
  release it ships in, and it appears here with the next sync.
- **Features and new dependencies: please open an issue before writing code.**
  Feature PRs written against this mirror tend to go stale fast (package layout
  here follows the monorepo, and paths you build on may be consolidated away),
  and we would rather discuss the design before you invest the effort.
- **Security issues:** do not open a public issue or PR. See
  [SECURITY.md](SECURITY.md) for how to report privately.

## What we will and won't accept

These packages handle users' Lightning wallet credentials and move real money,
so the bar for the payment path is deliberately conservative:

- `@bolthub/pay` has **zero runtime dependencies** and stays that way.
- We do not add third-party runtime dependencies anywhere in the
  payment/wallet path, and we do not embed third-party protocols, badges, or
  conformance programs in these packages or their docs.
- Changes must be backward-compatible by default and come with tests
  (`bun test`; build `packages/pay` first, see the README).

If your idea needs any of the above, open an issue and make the case. A native,
dependency-free variant of a good idea is often something we will take.

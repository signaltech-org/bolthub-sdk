<!-- Synced from docs/specs/tool-payment-profile-v0.md in the bolthub
     monorepo (the canonical source). This copy ships with @bolthub/pay and
     describes the wire format the published package implements. -->

# bolthub Tool Payment Profile (TPP) — v0

**Status:** draft · **Version:** `0.1` · **Updated:** 2026-07-01

## What this is (and what it is not)

TPP is a thin, **rail-agnostic** convention with two jobs:

1. Let a tool **advertise a price** so an agent can reason about cost *before* it calls.
2. Carry a **payment challenge** and a **payment proof** across two transports,
   HTTP and MCP, using one envelope. The settlement rail (L402/Lightning) moves
   the money.

It is **not** a new settlement protocol. Money moves over an existing rail. TPP
standardises only the *discovery field* and the *envelope*; the rail-specific
bytes are defined by [L402/LSAT](https://github.com/lightninglabs/L402). The
novel surface is deliberately tiny so TPP can sit *on top of* Lightning rather
than competing with it.

The reference implementation is [`@bolthub/pay`](https://www.npmjs.com/package/@bolthub/pay)
(seller side). The L402 rail is wire-compatible with the bolthub hosted
gateway.

## Vocabulary

| Term | Meaning |
|---|---|
| **Resource** | The thing being paid for — an MCP tool or an HTTP endpoint. Identified by a stable string, e.g. `get_satellite_image`. |
| **Rail** | A settlement mechanism with a `scheme` id (`l402`). |
| **Offer** | One rail's concrete instructions to pay a price (an L402 invoice + token). |
| **Challenge** | "Payment required" + one or more Offers. |
| **Proof** | Opaque, rail-scoped evidence of payment the seller can verify. |

## The three messages

### 1 · Price advertisement (discovery-time, optional, advisory)

Lets an agent budget before calling. Carries no commitment.

```jsonc
{
  "version": "0.1",
  "price": { "amount": 2000, "asset": "sat" },
  "model": "per_call",
  "rails": ["l402"]
}
```

- `amount` — integer, in the asset's **smallest unit** (sats).
- `asset` — `"sat"`.
- `model` — `per_call` | `per_kb` | `prepaid`. v0 normative value: `per_call`.
- `rails` — schemes the seller will accept.

### 2 · Payment challenge (authoritative)

Returned when a call arrives without a valid proof. Carries the exact amount and
**one Offer per accepted rail**.

```jsonc
{
  "status": "payment_required",
  "version": "0.1",
  "price": { "amount": 2000, "asset": "sat" },
  "resource": "get_satellite_image",
  "offers": [ /* Offer, ... */ ],
  "expiresAt": 1751400000000
}
```

`expiresAt` is Unix milliseconds and bounds the earliest offer expiry.

**Offer — L402**:

```jsonc
{
  "scheme": "l402",
  "amount": 2000,
  "asset": "sat",
  "token": "<base64url(payload)>.<hexsig>",
  "invoice": "lnbc20n1p...",
  "expiresAt": 1751400000000,
  "wwwAuthenticate": "L402 macaroon=\"<token>\", invoice=\"lnbc20n1p...\""
}
```

### 3 · Payment proof

The buyer pays an Offer, then re-issues the **same call** with:

```jsonc
{ "scheme": "l402", "proof": "<token>:<preimageHex>" }
```

`proof` is rail-defined and opaque to TPP. For **L402** it is exactly the value
that follows `L402 ` in the HTTP `Authorization` header (`<token>:<preimage>`).
A seller MUST verify that `proof.scheme` is a rail it actually offered.

## Transports

The three messages are transport-independent. Only the envelope differs.

### HTTP profile (origin servers, gateways)

| Message | Carrier |
|---|---|
| Advertisement | discovery doc / `x-payment` metadata (optional) |
| Challenge | `402 Payment Required`; one `WWW-Authenticate: <Scheme> …` header per Offer. The JSON body MAY mirror all Offers for clients that prefer a single parser. |
| Proof | `Authorization: <Scheme> <proof>` on the retried request. |

This is exactly what the bolthub gateway already emits for L402
(`L402 macaroon="…", invoice="…"`, plus the legacy `LSAT` alias). TPP just names it.

### MCP profile (tools)

MCP tool calls are JSON-RPC, not HTTP — there is **no 402 status**. TPP maps the
three messages onto MCP `_meta` under the reverse-DNS key **`ai.bolthub/payment`**:

| Message | Carrier |
|---|---|
| Advertisement | tool `_meta["ai.bolthub/payment"]` = the Advertisement object |
| Challenge | a `CallToolResult` with `isError: true`, a human-readable text block (`"Payment required: 2000 sat to use get_satellite_image"`), and `_meta["ai.bolthub/payment"]` = the Challenge object. A payment-blind client sees an ordinary tool error; a payment-aware client reads the challenge. |
| Proof | the buyer re-calls the tool with the Proof object in request `params._meta["ai.bolthub/payment"]` (surfaced to the handler as `extra._meta`). |

The L402 `proof` string is **identical across transports** — only the envelope
changes (HTTP header vs MCP `_meta`). That symmetry is the point: one mental
model, any transport, any rail.

## L402 token (reference rail)

The L402 Offer reuses bolthub's existing token + preimage scheme so it is
wire-compatible with the gateway:

- `token = base64url(json(payload)) + "." + hex(HMAC_SHA256(secret, "l402:" + base64url(json(payload))))`
- `payload = { paymentHash, resource, expiresAt }` — `expiresAt` in Unix ms.
  The hosted gateway adds `tenantId`/`endpointId` caveats and may use real
  macaroons; those are compatible supersets of this minimal payload.
- **Verify:** constant-time HMAC check → reject missing/non-future `expiresAt`
  → `SHA256(preimageHex) == paymentHash` (constant-time).
- Domain-separation prefix `l402:` matches the gateway; session tokens use `session:`.

## Security requirements

- Tokens MUST be HMAC-signed, scoped to a `resource`, and time-limited.
- Preimage and signature comparisons MUST be constant-time.
- A seller MUST reject a proof whose `resource` differs from the called resource
  (prevents a proof minted for tool A from unlocking tool B).
- A paywall MUST fail closed: no `resource`, no unverifiable proof → no service.
- Replay: an L402 token is single-priced and time-bound. Sellers MAY additionally
  record spent `paymentHash`es for at-most-once semantics.

## Versioning

`version: "0.1"`. While pre-1.0, breaking changes bump the minor. Receivers MUST
ignore unknown fields.

## Out of scope for v0 (tracked, not forgotten)

- prepaid/metered session accounting — the gateway has `X-Session-Token`; TPP
  will fold it into the envelope in a later revision.
- discovery / registry format — emerges from payment data, not specified here.

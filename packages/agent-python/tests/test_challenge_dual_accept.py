"""Challenge parser dual-accepts token= and macaroon= (AF-G6).

Hedges the L402 spec's token-agnostic rename (bLIP-0026): the SDK reads a
`token="..."` credential as well as the historical `macaroon="..."`, with
macaroon winning when both are present so today's gateways are unchanged.
"""

from __future__ import annotations

from bolthub._engine import parse_challenge


def test_parses_legacy_macaroon_field():
    got = parse_challenge('L402 macaroon="mac123", invoice="lnbc1"')
    assert got == ("mac123", "lnbc1")


def test_parses_token_field():
    got = parse_challenge('L402 token="tok456", invoice="lnbc2"')
    assert got == ("tok456", "lnbc2")


def test_macaroon_wins_when_both_present():
    # A transitional gateway emitting both must resolve deterministically to
    # macaroon= so behavior never changes for current gateways.
    got = parse_challenge('L402 macaroon="mac", token="tok", invoice="lnbc3"')
    assert got == ("mac", "lnbc3")


def test_missing_credential_or_invoice_is_none():
    assert parse_challenge('L402 invoice="lnbc4"') is None
    assert parse_challenge('L402 token="tok"') is None
    assert parse_challenge(None) is None


def test_does_not_match_token_inside_another_field_name():
    # A stray "mytoken=" must not be picked up (word boundary).
    assert parse_challenge('L402 mytoken="nope", invoice="lnbc5"') is None

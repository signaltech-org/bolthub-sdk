"""Offline attenuation (bolthub.attenuate)."""

import base64
from datetime import datetime, timezone

import pytest

from bolthub import attenuate

pytest.importorskip("pymacaroons")
from pymacaroons import Macaroon  # noqa: E402
from pymacaroons.serializers import BinarySerializer  # noqa: E402


def _mint() -> str:
    """Mint a gateway-shaped macaroon: std-base64 of a libmacaroons v2 binary."""
    m = Macaroon(
        location="bolthub",
        identifier='{"v":1,"kid":"x","tid":"t1"}',
        key="rootkey",
    )
    for c in ("payment_hash=abc", "tenant_id=t1", "endpoint_id=e1"):
        m = m.add_first_party_caveat(c)
    ser = m.serialize(serializer=BinarySerializer())
    raw = base64.urlsafe_b64decode(ser + "=" * (-len(ser) % 4))
    return base64.b64encode(raw).decode()


def _caveat_ids(macaroon_b64: str):
    raw = base64.b64decode(macaroon_b64)
    s = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    m = Macaroon.deserialize(s, serializer=BinarySerializer())
    ids = []
    for c in m.caveats:
        cid = c.caveat_id
        ids.append(cid.decode() if isinstance(cid, (bytes, bytearray)) else cid)
    return ids


def test_attenuate_adds_method_and_valid_until():
    out = attenuate(_mint(), method="GET", valid_until=9999999999999)
    ids = _caveat_ids(out)
    assert "method=GET" in ids
    assert "valid_until=9999999999999" in ids
    # binding caveats are preserved.
    assert "payment_hash=abc" in ids


def test_attenuate_requires_a_restriction():
    with pytest.raises(ValueError):
        attenuate(_mint())


def test_attenuate_accepts_datetime():
    dt = datetime(2030, 1, 1, tzinfo=timezone.utc)
    out = attenuate(_mint(), valid_until=dt)
    assert f"valid_until={int(dt.timestamp() * 1000)}" in _caveat_ids(out)


def test_attenuate_output_is_std_base64():
    # The wire field uses standard base64 (not urlsafe); output must decode cleanly.
    base64.b64decode(attenuate(_mint(), method="GET"))


# --- Caveat schema v2 (AF-D4): n_uses / max_sats / path_prefix ---


def _mint_with(*caveats: str) -> str:
    """Mint a macaroon that already carries v2 caveats, to test tighten-only."""
    m = Macaroon(location="bolthub", identifier='{"v":1,"kid":"x"}', key="rootkey")
    m = m.add_first_party_caveat("payment_hash=abc")
    for c in caveats:
        m = m.add_first_party_caveat(c)
    ser = m.serialize(serializer=BinarySerializer())
    raw = base64.urlsafe_b64decode(ser + "=" * (-len(ser) % 4))
    return base64.b64encode(raw).decode()


def test_attenuate_adds_v2_caveats_and_normalizes_path():
    out = attenuate(_mint(), n_uses=50, max_sats=300, path_prefix="/v1/user/")
    ids = _caveat_ids(out)
    assert "n_uses=50" in ids
    assert "max_sats=300" in ids
    assert "path_prefix=/v1/user" in ids  # trailing slash normalized away


def test_n_uses_tighten_only():
    assert "n_uses=100" in _caveat_ids(attenuate(_mint_with("n_uses=100"), n_uses=100))
    assert "n_uses=10" in _caveat_ids(attenuate(_mint_with("n_uses=100"), n_uses=10))
    with pytest.raises(ValueError, match="can only tighten"):
        attenuate(_mint_with("n_uses=100"), n_uses=101)


def test_max_sats_tighten_only():
    assert "max_sats=500" in _caveat_ids(attenuate(_mint_with("max_sats=500"), max_sats=500))
    with pytest.raises(ValueError, match="can only tighten"):
        attenuate(_mint_with("max_sats=500"), max_sats=501)


def test_path_prefix_narrow_only():
    parent = _mint_with("path_prefix=/v1/user")
    assert "path_prefix=/v1/user/42" in _caveat_ids(attenuate(parent, path_prefix="/v1/user/42"))
    assert "path_prefix=/v1/user" in _caveat_ids(attenuate(parent, path_prefix="/v1/user"))
    for widen in ("/v1/admin", "/v1", "/v1/userdata"):
        with pytest.raises(ValueError, match="can only tighten"):
            attenuate(parent, path_prefix=widen)


def test_valid_until_earlier_only():
    assert "valid_until=1500" in _caveat_ids(attenuate(_mint_with("valid_until=2000"), valid_until=1500))
    with pytest.raises(ValueError, match="can only tighten"):
        attenuate(_mint_with("valid_until=2000"), valid_until=2001)


def test_path_prefix_normalization_rejects_bad_input():
    for bad in ("/v1/../admin", "/v1//user", "no-leading-slash"):
        with pytest.raises(ValueError):
            attenuate(_mint(), path_prefix=bad)


def test_v2_int_validation_rejects_bad_values():
    for bad in (0, -5, 1.5, 1 << 32, True):
        with pytest.raises(ValueError):
            attenuate(_mint(), n_uses=bad)
        with pytest.raises(ValueError):
            attenuate(_mint(), max_sats=bad)

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

"""Offline delegation: narrow an L402 macaroon by appending first-party caveats.

A parent agent that paid for access can hand a sub-agent a *restricted*
credential without contacting bolthub or re-paying. This is the macaroon
"attenuation" property: anyone holding a macaroon can append caveats offline.

Requires the optional ``pymacaroons`` package::

    pip install bolthub[delegation]
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import List, Optional, Union


def attenuate(
    macaroon: str,
    *,
    method: Optional[str] = None,
    valid_until: Optional[Union[int, datetime]] = None,
) -> str:
    """Return a narrowed copy of an L402 macaroon (base64).

    ``macaroon`` is the value from the ``L402 <macaroon>:<preimage>`` credential
    (equivalently, the ``macaroon="..."`` field of the 402 challenge).

    Restrictions (at least one required):

    - ``method``: limit to a single HTTP method, e.g. ``"GET"``.
    - ``valid_until``: a tighter expiry than the macaroon's own, as Unix
      milliseconds or a ``datetime`` (naive datetimes are treated as UTC).

    Hand the result plus the SAME preimage to the sub-agent, which authenticates
    with ``Authorization: L402 <attenuated>:<preimage>``. The bolthub gateway
    enforces every caveat down the chain (most restrictive wins).
    """
    try:
        from pymacaroons import Macaroon
        from pymacaroons.serializers import BinarySerializer
    except ImportError as exc:  # pragma: no cover - import-guard message
        raise ImportError(
            "attenuate() needs the optional 'pymacaroons' package. "
            "Install it with: pip install bolthub[delegation]"
        ) from exc

    caveats = _caveats(method, valid_until)
    if not caveats:
        raise ValueError(
            "attenuate() needs at least one restriction (method or valid_until)"
        )

    # The gateway emits/accepts standard base64; pymacaroons' BinarySerializer
    # speaks unpadded urlsafe base64 around the same libmacaroons v2 binary, so
    # we bridge the two encodings on the way in and out.
    raw = base64.b64decode(macaroon)
    m = Macaroon.deserialize(_b64url_encode(raw), serializer=BinarySerializer())
    for c in caveats:
        m = m.add_first_party_caveat(c)
    out = _b64url_decode(m.serialize(serializer=BinarySerializer()))
    return base64.b64encode(out).decode()


def _caveats(
    method: Optional[str], valid_until: Optional[Union[int, datetime]]
) -> List[str]:
    out: List[str] = []
    if method:
        out.append(f"method={method}")
    if valid_until is not None:
        if isinstance(valid_until, datetime):
            dt = valid_until
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            ms = int(dt.timestamp() * 1000)
        else:
            ms = int(valid_until)
        out.append(f"valid_until={ms}")
    return out


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

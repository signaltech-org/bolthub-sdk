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

from .path_caveat import (
    normalize_path_prefix,
    parse_caveat_int,
    path_matches_prefix,
)

_UINT32_MAX = (1 << 32) - 1


def attenuate(
    macaroon: str,
    *,
    method: Optional[str] = None,
    valid_until: Optional[Union[int, datetime]] = None,
    n_uses: Optional[int] = None,
    max_sats: Optional[int] = None,
    path_prefix: Optional[str] = None,
) -> str:
    """Return a narrowed copy of an L402 macaroon (base64).

    ``macaroon`` is the value from the ``L402 <macaroon>:<preimage>`` credential
    (equivalently, the ``macaroon="..."`` field of the 402 challenge).

    Restrictions (at least one required):

    - ``method``: limit to a single HTTP method, e.g. ``"GET"``.
    - ``valid_until``: a tighter expiry than the macaroon's own, as Unix
      milliseconds or a ``datetime`` (naive datetimes are treated as UTC).
    - ``n_uses``: cap total remaining requests (caveat schema v2).
    - ``max_sats``: cap cumulative spend in sats (caveat schema v2).
    - ``path_prefix``: restrict to request paths at or under this prefix
      (caveat schema v2; normalized per DESIGN.md §3).

    Attenuation is **tighten-only**: each restriction is validated against the
    caveats the macaroon already carries and raises ``ValueError`` if it would
    raise ``n_uses``/``max_sats``, widen ``path_prefix``, or push
    ``valid_until`` later than an existing bound. The gateway verifier enforces
    the same folds, so a bypass still cannot escalate; this fails fast instead
    of minting a token that silently behaves tighter than asked.

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

    # The gateway emits/accepts standard base64; pymacaroons' BinarySerializer
    # speaks unpadded urlsafe base64 around the same libmacaroons v2 binary, so
    # we bridge the two encodings on the way in and out.
    raw = base64.b64decode(macaroon)
    m = Macaroon.deserialize(_b64url_encode(raw), serializer=BinarySerializer())

    caveats = _caveats(
        _existing_bounds(m),
        method=method,
        valid_until=valid_until,
        n_uses=n_uses,
        max_sats=max_sats,
        path_prefix=path_prefix,
    )
    if not caveats:
        raise ValueError(
            "attenuate() needs at least one restriction "
            "(method, valid_until, n_uses, max_sats, or path_prefix)"
        )

    for c in caveats:
        m = m.add_first_party_caveat(c)
    out = _b64url_decode(m.serialize(serializer=BinarySerializer()))
    return base64.b64encode(out).decode()


class _Bounds:
    """The tightest v2 bound the macaroon already carries, per the verifier fold
    (n_uses/max_sats = min, valid_until = earliest, path_prefix = longest)."""

    n_uses: Optional[int] = None
    max_sats: Optional[int] = None
    valid_until_ms: Optional[int] = None
    path_prefix: Optional[str] = None


def _existing_bounds(m) -> _Bounds:
    b = _Bounds()
    for cav in m.caveats:
        cid = getattr(cav, "caveat_id", None)
        if isinstance(cid, (bytes, bytearray)):
            cid = cid.decode("utf-8", errors="replace")
        if not isinstance(cid, str) or "=" not in cid:
            continue
        key, _, val = cid.partition("=")
        try:
            if key == "n_uses":
                n = parse_caveat_int(val)
                b.n_uses = n if b.n_uses is None else min(b.n_uses, n)
            elif key == "max_sats":
                n = parse_caveat_int(val)
                b.max_sats = n if b.max_sats is None else min(b.max_sats, n)
            elif key == "valid_until":
                ms = int(val)
                b.valid_until_ms = ms if b.valid_until_ms is None else min(b.valid_until_ms, ms)
            elif key == "path_prefix":
                norm = normalize_path_prefix(val)
                if b.path_prefix is None or len(norm) > len(b.path_prefix):
                    b.path_prefix = norm
        except (ValueError, TypeError):
            # Skip a malformed existing caveat; the verifier fails it closed.
            continue
    return b


def _caveats(
    bounds: _Bounds,
    *,
    method: Optional[str],
    valid_until: Optional[Union[int, datetime]],
    n_uses: Optional[int],
    max_sats: Optional[int],
    path_prefix: Optional[str],
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
        if bounds.valid_until_ms is not None and ms > bounds.valid_until_ms:
            raise ValueError(
                f"valid_until {ms} is later than the credential's existing "
                f"expiry {bounds.valid_until_ms} (can only tighten)"
            )
        out.append(f"valid_until={ms}")
    if n_uses is not None:
        n = _validate_caveat_uint(n_uses, "n_uses")
        if bounds.n_uses is not None and n > bounds.n_uses:
            raise ValueError(
                f"n_uses {n} exceeds the credential's existing n_uses "
                f"{bounds.n_uses} (can only tighten)"
            )
        out.append(f"n_uses={n}")
    if max_sats is not None:
        n = _validate_caveat_uint(max_sats, "max_sats")
        if bounds.max_sats is not None and n > bounds.max_sats:
            raise ValueError(
                f"max_sats {n} exceeds the credential's existing max_sats "
                f"{bounds.max_sats} (can only tighten)"
            )
        out.append(f"max_sats={n}")
    if path_prefix is not None:
        norm = normalize_path_prefix(path_prefix)  # raises on ../, //, bad encoding
        if bounds.path_prefix is not None and not path_matches_prefix(norm, bounds.path_prefix):
            raise ValueError(
                f"path_prefix {norm!r} is not at or under the credential's "
                f"existing path_prefix {bounds.path_prefix!r} (can only tighten)"
            )
        out.append(f"path_prefix={norm}")
    return out


def _validate_caveat_uint(n: int, name: str) -> int:
    """Validate an n_uses/max_sats attenuation input: a positive integer within
    the 2**32-1 caveat ceiling, matching the gateway's parsePositiveCaveatInt.
    ``bool`` is rejected (it is an int subclass and never a valid count)."""
    if isinstance(n, bool) or not isinstance(n, int) or n <= 0:
        raise ValueError(f"{name} must be a positive integer")
    if n > _UINT32_MAX:
        raise ValueError(f"{name} exceeds the 2**32-1 caveat ceiling")
    return n


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

"""Caveat schema v2 path/int helpers — the Python side of the cross-language
contract (agent-features AF-G5).

A faithful port of the Go gateway verifier
(apps/gateway-go/internal/l402/pathcaveat.go) and the TS SDK
(packages/pay/src/http/path-caveat.ts) so a token this SDK attenuates with a
``path_prefix`` (AF-D4) is judged the same by the gateway. The shared vectors
in ``tests/fixtures/caveat_vectors.json`` pin all three. Spec:
docs/design/agent-features/DESIGN.md §3.
"""

from __future__ import annotations

import re
from urllib.parse import unquote

__all__ = [
    "normalize_path_prefix",
    "normalize_request_path",
    "path_matches_prefix",
    "parse_caveat_int",
]

_DIGITS = re.compile(r"^[0-9]+$")


def normalize_path_prefix(p: str) -> str:
    """Normalize a ``path_prefix`` CAVEAT value; raises ValueError on reject."""
    return _normalize_core(p, is_caveat=True)


def normalize_request_path(p: str) -> str:
    """Normalize an incoming request path; raises ValueError on reject."""
    return _normalize_core(p, is_caveat=False)


def _normalize_core(p: str, *, is_caveat: bool) -> str:
    if p == "":
        raise ValueError("empty path")
    # Single decode; matches Go url.PathUnescape / JS decodeURIComponent.
    decoded = unquote(p, errors="strict")
    if not decoded.startswith("/"):
        raise ValueError("path must start with /")
    if "://" in decoded or decoded.startswith("//"):
        raise ValueError("path must not contain scheme or authority")
    if "\\" in decoded:
        raise ValueError("path must not contain backslash")

    # A caveat rejects an INTERIOR `//`; a single trailing slash is fine. Match
    # Go/TS: trim ONE trailing slash, then check for `//`.
    if is_caveat:
        trimmed = decoded
        if trimmed != "/" and trimmed.endswith("/"):
            trimmed = trimmed[:-1]
        if "//" in trimmed:
            raise ValueError("path_prefix must not contain an interior // segment")

    out: list[str] = []
    for s in decoded.split("/")[1:]:
        if s == "..":
            raise ValueError("path must not contain a .. segment")
        if s in (".", ""):
            continue
        out.append(s)
    return "/" + "/".join(out)


def path_matches_prefix(req_path: str, prefix: str) -> bool:
    """Segment-boundary prefix match on already-normalized inputs.
    Case-SENSITIVE. ``/`` matches everything."""
    if prefix == "/":
        return True
    if req_path == prefix:
        return True
    return req_path.startswith(prefix + "/")


def parse_caveat_int(val: str) -> int:
    """Parse an n_uses / max_sats caveat value: digits only, strictly positive,
    bounded at 2**32-1. Raises ValueError on anything else."""
    if not _DIGITS.match(val):
        raise ValueError(f"value {val!r} is not a plain non-negative integer")
    n = int(val)
    if n == 0:
        raise ValueError("value must be positive")
    if n > (1 << 32) - 1:
        raise ValueError("value exceeds the 2**32-1 caveat ceiling")
    return n

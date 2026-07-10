"""Caveat schema v2 cross-language vectors — Python side (AF-G5).

Reads the SAME fixture the Go gateway verifier and the TS SDK assert against,
so none of the three implementations can drift on path_prefix normalization,
matching, or n_uses/max_sats parsing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bolthub.path_caveat import (
    normalize_path_prefix,
    normalize_request_path,
    parse_caveat_int,
    path_matches_prefix,
)

FIXTURE = Path(__file__).parent / "fixtures" / "caveat_vectors.json"
VECTORS = json.loads(FIXTURE.read_text())


def test_normalize_prefix():
    for c in VECTORS["normalize_prefix"]:
        if c.get("reject"):
            with pytest.raises(ValueError):
                normalize_path_prefix(c["in"])
        else:
            assert normalize_path_prefix(c["in"]) == c["out"], c["in"]


def test_normalize_request():
    for c in VECTORS["normalize_request"]:
        if c.get("reject"):
            with pytest.raises(ValueError):
                normalize_request_path(c["in"])
        else:
            assert normalize_request_path(c["in"]) == c["out"], c["in"]


def test_match():
    for c in VECTORS["match"]:
        assert path_matches_prefix(c["path"], c["prefix"]) is c["match"], c


def test_parse_int():
    for c in VECTORS["parse_int"]:
        if c.get("reject"):
            with pytest.raises(ValueError):
                parse_caveat_int(c["in"])
        else:
            assert parse_caveat_int(c["in"]) == c["value"], c["in"]

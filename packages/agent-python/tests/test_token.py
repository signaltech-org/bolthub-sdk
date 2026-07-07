import base64
import hashlib
import hmac
import json
import time

import pytest

from bolthub import (
    random_preimage,
    sha256_hex,
    sign_l402_token,
    verify_l402_token,
    verify_preimage,
)

SECRET = "test-secret-at-least-thirty-two-bytes-long!!"


def _now_ms():
    return int(time.time() * 1000)


def _forge_token(payload_json: str, secret: str = SECRET) -> str:
    """Hand-roll a token for payloads sign_l402_token refuses to emit."""
    encoded = base64.urlsafe_b64encode(payload_json.encode()).decode().rstrip("=")
    sig = hmac.new(secret.encode(), f"l402:{encoded}".encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{sig}"


class TestL402Token:
    def test_signs_and_verifies_a_round_trip(self):
        expires_at = _now_ms() + 60_000
        token = sign_l402_token(
            SECRET,
            {"paymentHash": "ab" * 32, "resource": "tool_x", "expiresAt": expires_at},
        )
        res = verify_l402_token(SECRET, token)
        assert res["ok"] is True
        assert res["payload"]["resource"] == "tool_x"
        assert res["payload"]["paymentHash"] == "ab" * 32

    def test_integral_float_expiry_signs_like_an_int(self):
        expires_at = 4102444800000
        as_int = sign_l402_token(
            SECRET, {"paymentHash": "ab" * 32, "resource": "t", "expiresAt": expires_at}
        )
        as_float = sign_l402_token(
            SECRET,
            {"paymentHash": "ab" * 32, "resource": "t", "expiresAt": float(expires_at)},
        )
        assert as_int == as_float

    def test_rejects_a_wrong_secret(self):
        token = sign_l402_token(
            SECRET,
            {"paymentHash": "ab" * 32, "resource": "t", "expiresAt": _now_ms() + 60_000},
        )
        res = verify_l402_token("another-secret-also-thirty-two-bytes-xx!", token)
        assert res == {"ok": False, "reason": "bad signature"}

    def test_rejects_a_tampered_payload(self):
        token = sign_l402_token(
            SECRET,
            {"paymentHash": "ab" * 32, "resource": "t", "expiresAt": _now_ms() + 60_000},
        )
        encoded, sig = token.rsplit(".", 1)
        forged = (
            base64.urlsafe_b64encode(
                json.dumps(
                    {"paymentHash": "cd" * 32, "resource": "t", "expiresAt": _now_ms() + 60_000},
                    separators=(",", ":"),
                ).encode()
            )
            .decode()
            .rstrip("=")
        )
        assert forged != encoded
        res = verify_l402_token(SECRET, f"{forged}.{sig}")
        assert res["ok"] is False

    def test_rejects_an_expired_token(self):
        token = sign_l402_token(
            SECRET, {"paymentHash": "ab" * 32, "resource": "t", "expiresAt": 1000}
        )
        res = verify_l402_token(SECRET, token, now=2000)
        assert res == {"ok": False, "reason": "token expired"}

    def test_rejects_malformed_tokens(self):
        assert verify_l402_token(SECRET, "nodot")["ok"] is False
        assert verify_l402_token(SECRET, "trailing.")["ok"] is False
        assert verify_l402_token(SECRET, ".leading")["ok"] is False

    def test_rejects_missing_expires_at(self):
        token = _forge_token(json.dumps({"paymentHash": "ab" * 32, "resource": "t"}))
        assert verify_l402_token(SECRET, token) == {
            "ok": False,
            "reason": "missing expiresAt",
        }

    def test_rejects_incomplete_payload(self):
        token = _forge_token(json.dumps({"resource": "t", "expiresAt": _now_ms() + 60_000}))
        assert verify_l402_token(SECRET, token) == {
            "ok": False,
            "reason": "incomplete payload",
        }

    def test_rejects_undecodable_payload(self):
        token = _forge_token("this is not json")
        assert verify_l402_token(SECRET, token) == {
            "ok": False,
            "reason": "undecodable payload",
        }


class TestPreimage:
    def test_accepts_a_matching_preimage(self):
        preimage = random_preimage()
        assert verify_preimage(preimage, sha256_hex(preimage)) is True

    def test_rejects_a_non_matching_preimage(self):
        assert verify_preimage(random_preimage(), sha256_hex(random_preimage())) is False

    def test_rejects_malformed_hex_and_wrong_lengths(self):
        hash_hex = sha256_hex(random_preimage())
        assert verify_preimage("zz" * 32, hash_hex) is False  # non-hex
        assert verify_preimage("ab", hash_hex) is False  # too short
        assert verify_preimage(random_preimage(), "ab") is False  # bad hash length

    def test_random_preimage_is_32_bytes_of_hex(self):
        preimage = random_preimage()
        assert len(preimage) == 64
        bytes.fromhex(preimage)
        assert preimage != random_preimage()

    def test_sha256_hex_rejects_bad_input(self):
        with pytest.raises(ValueError, match="even-length hex"):
            sha256_hex("abc")
        with pytest.raises(ValueError, match="even-length hex"):
            sha256_hex("")

import hashlib
import hmac
import time

import pytest

from bolthub_verify import (
    VerifyResult,
    verify_gateway_signature,
    verify_gateway_secret,
)

SECRET = "test-secret-key-32chars-long!!!!"


def _sign(method, path, timestamp, nonce, body, secret=SECRET):
    payload = f"{method}\n{path}\n{timestamp}\n{nonce}\n{body}"
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _make_kwargs(method="GET", path="/api/data", body="", secret=SECRET):
    timestamp = str(int(time.time() * 1000))
    nonce = "test-nonce-123"
    signature = _sign(method, path, timestamp, nonce, body, secret)
    return {
        "method": method,
        "path": path,
        "signature": signature,
        "timestamp": timestamp,
        "nonce": nonce,
        "body": body,
        "secrets": secret,
    }


class TestVerifyGatewaySignature:
    def test_accepts_valid_signature(self):
        result = verify_gateway_signature(**_make_kwargs())
        assert result.valid is True
        assert result.error is None

    def test_rejects_missing_headers(self):
        result = verify_gateway_signature(
            method="GET",
            path="/",
            signature=None,
            timestamp=None,
            nonce=None,
            body="",
            secrets=SECRET,
        )
        assert result.valid is False
        assert "Missing" in result.error

    def test_rejects_expired_timestamp(self):
        old_ts = str(int(time.time() * 1000) - 60_000)
        kwargs = _make_kwargs()
        kwargs["timestamp"] = old_ts
        kwargs["signature"] = _sign("GET", "/api/data", old_ts, "test-nonce-123", "")
        result = verify_gateway_signature(**kwargs)
        assert result.valid is False
        assert "expired" in result.error

    def test_rejects_future_timestamp(self):
        future_ts = str(int(time.time() * 1000) + 60_000)
        kwargs = _make_kwargs()
        kwargs["timestamp"] = future_ts
        kwargs["signature"] = _sign("GET", "/api/data", future_ts, "test-nonce-123", "")
        result = verify_gateway_signature(**kwargs)
        assert result.valid is False
        assert "clock skew" in result.error or "expired" in result.error

    def test_rejects_invalid_signature(self):
        kwargs = _make_kwargs()
        kwargs["signature"] = "deadbeef"
        result = verify_gateway_signature(**kwargs)
        assert result.valid is False
        assert "Invalid" in result.error

    def test_supports_secret_rotation(self):
        old_secret = "old-secret-key-32chars-long!!!!!"
        kwargs = _make_kwargs(secret=old_secret)
        kwargs["secrets"] = [SECRET, old_secret]
        result = verify_gateway_signature(**kwargs)
        assert result.valid is True

    def test_rejects_when_no_secret_matches(self):
        kwargs = _make_kwargs(secret="wrong-secret-32chars-long!!!!!!!!")
        kwargs["secrets"] = [SECRET]
        result = verify_gateway_signature(**kwargs)
        assert result.valid is False

    def test_handles_post_with_body(self):
        kwargs = _make_kwargs(method="POST", body='{"key":"value"}')
        result = verify_gateway_signature(**kwargs)
        assert result.valid is True

    def test_custom_max_age(self):
        old_ts = str(int(time.time() * 1000) - 5_000)
        kwargs = _make_kwargs()
        kwargs["timestamp"] = old_ts
        kwargs["signature"] = _sign("GET", "/api/data", old_ts, "test-nonce-123", "")

        kwargs["max_age_ms"] = 1_000
        result = verify_gateway_signature(**kwargs)
        assert result.valid is False

        kwargs["max_age_ms"] = 10_000
        result = verify_gateway_signature(**kwargs)
        assert result.valid is True


class TestVerifyGatewaySecret:
    def test_accepts_valid_secret(self):
        result = verify_gateway_secret(header_value=SECRET, secrets=SECRET)
        assert result.valid is True

    def test_rejects_missing_header(self):
        result = verify_gateway_secret(header_value=None, secrets=SECRET)
        assert result.valid is False
        assert "Missing" in result.error

    def test_rejects_wrong_secret(self):
        result = verify_gateway_secret(header_value="wrong", secrets=SECRET)
        assert result.valid is False
        assert "Invalid" in result.error

    def test_supports_rotation(self):
        old_secret = "old-secret"
        result = verify_gateway_secret(
            header_value=old_secret, secrets=[SECRET, old_secret]
        )
        assert result.valid is True


class TestVerifyResult:
    def test_valid_result(self):
        r = VerifyResult(valid=True)
        assert r.valid is True
        assert r.error is None

    def test_invalid_result(self):
        r = VerifyResult(valid=False, error="test error")
        assert r.valid is False
        assert r.error == "test error"

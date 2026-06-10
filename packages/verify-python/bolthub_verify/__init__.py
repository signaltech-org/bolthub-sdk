"""Verify bolthub gateway signatures on your origin server."""

from __future__ import annotations

import hashlib
import hmac as _hmac
import time
from dataclasses import dataclass
from typing import Sequence, Union

__all__ = [
    "VerifyResult",
    "verify_gateway_signature",
    "verify_gateway_secret",
    "flask_hmac_middleware",
    "django_hmac_middleware",
    "fastapi_hmac_middleware",
]

DEFAULT_MAX_AGE_MS = 30_000


@dataclass
class VerifyResult:
    valid: bool
    error: str | None = None


def _safe_compare(a: str, b: str) -> bool:
    return _hmac.compare_digest(a.encode(), b.encode())


def verify_gateway_signature(
    *,
    method: str,
    path: str,
    signature: str | None,
    timestamp: str | None,
    nonce: str | None,
    body: str = "",
    secrets: Union[str, Sequence[str]],
    max_age_ms: int = DEFAULT_MAX_AGE_MS,
) -> VerifyResult:
    """
    Verify the X-Gateway-Signature HMAC-SHA256 header.

    The signature covers the canonical payload::

        METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nBODY
    """
    if not signature or not timestamp or not nonce:
        return VerifyResult(valid=False, error="Missing gateway signature headers")

    try:
        age_ms = int(time.time() * 1000) - int(timestamp)
    except (ValueError, OverflowError):
        return VerifyResult(valid=False, error="Invalid timestamp")

    if age_ms > max_age_ms or age_ms < 0:
        return VerifyResult(
            valid=False,
            error="Request signature expired or clock skew detected",
        )

    payload = f"{method}\n{path}\n{timestamp}\n{nonce}\n{body}"

    if isinstance(secrets, str):
        secrets = [secrets]

    for secret in secrets:
        if not secret:
            continue
        expected = _hmac.new(
            secret.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        if _safe_compare(expected, signature):
            return VerifyResult(valid=True)

    return VerifyResult(valid=False, error="Invalid gateway signature")


def verify_gateway_secret(
    *,
    header_value: str | None,
    secrets: Union[str, Sequence[str]],
) -> VerifyResult:
    """Verify the X-Gateway-Secret shared secret header."""
    if not header_value:
        return VerifyResult(valid=False, error="Missing X-Gateway-Secret header")

    if isinstance(secrets, str):
        secrets = [secrets]

    for secret in secrets:
        if not secret:
            continue
        if _safe_compare(secret, header_value):
            return VerifyResult(valid=True)

    return VerifyResult(valid=False, error="Invalid gateway secret")


# ---------------------------------------------------------------------------
# Flask middleware
# ---------------------------------------------------------------------------


def flask_hmac_middleware(
    secrets: Union[str, Sequence[str]],
    max_age_ms: int = DEFAULT_MAX_AGE_MS,
):
    """
    Flask ``before_request`` hook that rejects unsigned requests.

    Usage::

        from bolthub_verify import flask_hmac_middleware
        app.before_request(flask_hmac_middleware(["current_secret", "previous_secret"]))
    """
    from flask import abort, request as flask_request

    def _hook():
        body = flask_request.get_data(as_text=True)
        result = verify_gateway_signature(
            method=flask_request.method,
            path=flask_request.path,
            signature=flask_request.headers.get("X-Gateway-Signature"),
            timestamp=flask_request.headers.get("X-Gateway-Timestamp"),
            nonce=flask_request.headers.get("X-Gateway-Nonce"),
            body=body,
            secrets=secrets,
            max_age_ms=max_age_ms,
        )
        if not result.valid:
            abort(403, description=result.error)

    return _hook


# ---------------------------------------------------------------------------
# Django middleware
# ---------------------------------------------------------------------------


def django_hmac_middleware(get_response):
    """
    Django middleware factory.

    Add to ``MIDDLEWARE`` and set ``BOLTHUB_HMAC_SECRETS`` in settings::

        MIDDLEWARE = [
            "bolthub_verify.django_hmac_middleware",
            ...
        ]
        BOLTHUB_HMAC_SECRETS = ["current", "previous"]
    """
    from django.conf import settings
    from django.http import JsonResponse

    secrets = getattr(settings, "BOLTHUB_HMAC_SECRETS", [])
    max_age_ms = getattr(settings, "BOLTHUB_MAX_AGE_MS", DEFAULT_MAX_AGE_MS)

    def middleware(request):
        result = verify_gateway_signature(
            method=request.method,
            path=request.path,
            signature=request.META.get("HTTP_X_GATEWAY_SIGNATURE"),
            timestamp=request.META.get("HTTP_X_GATEWAY_TIMESTAMP"),
            nonce=request.META.get("HTTP_X_GATEWAY_NONCE"),
            body=request.body.decode("utf-8") if request.body else "",
            secrets=secrets,
            max_age_ms=max_age_ms,
        )
        if not result.valid:
            return JsonResponse({"error": result.error}, status=403)
        return get_response(request)

    return middleware


# ---------------------------------------------------------------------------
# FastAPI / Starlette middleware
# ---------------------------------------------------------------------------


def fastapi_hmac_middleware(
    secrets: Union[str, Sequence[str]],
    max_age_ms: int = DEFAULT_MAX_AGE_MS,
):
    """
    FastAPI dependency that rejects unsigned requests.

    Usage::

        from bolthub_verify import fastapi_hmac_middleware
        verify = fastapi_hmac_middleware(["current_secret"])

        @app.get("/protected")
        async def protected(verified=Depends(verify)):
            ...
    """
    from fastapi import HTTPException, Request

    async def _dependency(request: Request):
        body = (await request.body()).decode("utf-8")
        result = verify_gateway_signature(
            method=request.method,
            path=request.url.path,
            signature=request.headers.get("x-gateway-signature"),
            timestamp=request.headers.get("x-gateway-timestamp"),
            nonce=request.headers.get("x-gateway-nonce"),
            body=body,
            secrets=secrets,
            max_age_ms=max_age_ms,
        )
        if not result.valid:
            raise HTTPException(status_code=403, detail=result.error)

    return _dependency

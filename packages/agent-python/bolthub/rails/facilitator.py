"""The SDK-to-facilitator bridge (seller side).

:func:`facilitator_rail` builds a rail that delegates minting and verification
to a **hosted bolthub facilitator** instead of computing them locally. Swap
``l402_rail(secret, invoice_provider)`` for
``facilitator_rail("l402", ["sat"], http_facilitator(base_url, api_key))`` and
the same paywall now runs on the hosted path — bolthub sits in the
metering/control flow (replay protection, usage analytics, discovery) but never
in the funds path. Mirrors ``@bolthub/pay``'s ``src/rails/facilitator.ts``.
"""

from __future__ import annotations

from typing import Any, Optional, Protocol, Sequence, runtime_checkable
from urllib.parse import urljoin

import httpx

__all__ = [
    "FacilitatorTransport",
    "FacilitatorRail",
    "HttpFacilitator",
    "facilitator_rail",
    "http_facilitator",
]


@runtime_checkable
class FacilitatorTransport(Protocol):
    """Transport to a hosted facilitator.

    :func:`http_facilitator` is the production implementation; tests and
    embedded use can supply an in-process one. Requests are dicts:
    ``mint`` takes ``{"scheme", "resource", "price"}`` and returns an offer
    dict; ``verify`` takes ``{"scheme", "resource", "price", "proof"}`` and
    returns a verify-result dict (``{"ok": ..., ...}``).
    """

    def mint(self, req: "dict[str, Any]") -> "dict[str, Any]": ...

    def verify(self, req: "dict[str, Any]") -> "dict[str, Any]": ...


class FacilitatorRail:
    """A payment rail that delegates to a hosted facilitator.

    Build one with :func:`facilitator_rail`.
    """

    def __init__(
        self, scheme: str, assets: Sequence[str], transport: FacilitatorTransport
    ) -> None:
        if not assets:
            raise ValueError("facilitator_rail: `assets` must be non-empty")
        self.scheme = scheme
        self.assets = tuple(assets)
        self._transport = transport

    def create_offer(self, price: "dict[str, Any]", resource: str) -> "dict[str, Any]":
        return self._transport.mint(
            {"scheme": self.scheme, "resource": resource, "price": price}
        )

    def verify(
        self, proof: str, *, resource: str, price: "dict[str, Any]"
    ) -> "dict[str, Any]":
        return self._transport.verify(
            {"scheme": self.scheme, "resource": resource, "price": price, "proof": proof}
        )


def facilitator_rail(
    scheme: str, assets: Sequence[str], transport: FacilitatorTransport
) -> FacilitatorRail:
    """Build a payment rail that delegates to a hosted facilitator.

    Args:
        scheme: Scheme this rail settles via the facilitator, e.g. ``"l402"``.
        assets: Assets the scheme settles, e.g. ``["sat"]``.
        transport: Transport to the facilitator (see :func:`http_facilitator`).
    """
    return FacilitatorRail(scheme, assets, transport)


class HttpFacilitator:
    """A :class:`FacilitatorTransport` that talks to a facilitator over HTTP.

    Build one with :func:`http_facilitator`.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        client: Optional[httpx.Client] = None,
        timeout: float = 30.0,
    ) -> None:
        self._base = base_url if base_url.endswith("/") else f"{base_url}/"
        self._headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        }
        self._client = client
        self._timeout = timeout

    def _post(self, op: str, body: "dict[str, Any]") -> "dict[str, Any]":
        url = urljoin(self._base, f"v1/{op}")
        if self._client is not None:
            resp = self._client.post(url, json=body, headers=self._headers)
        else:
            resp = httpx.post(url, json=body, headers=self._headers, timeout=self._timeout)
        if not resp.is_success:
            raise RuntimeError(f"facilitator v1/{op} returned {resp.status_code}")
        return resp.json()

    def mint(self, req: "dict[str, Any]") -> "dict[str, Any]":
        return self._post("mint", req)["offer"]

    def verify(self, req: "dict[str, Any]") -> "dict[str, Any]":
        return self._post("verify", req)


def http_facilitator(
    base_url: str,
    api_key: str,
    *,
    client: Optional[httpx.Client] = None,
    timeout: float = 30.0,
) -> HttpFacilitator:
    """Build an HTTP transport to a hosted facilitator.

    Args:
        base_url: Facilitator base URL. Endpoints are resolved *relative* to
            it, so the facilitator can be mounted under any prefix:
            ``https://facilitator.bolthub.ai`` hits ``/v1/mint``;
            ``https://api.bolthub.ai/facilitator`` hits ``/facilitator/v1/mint``.
        api_key: Seller API key (issued in the bolthub dashboard).
        client: Optional injected ``httpx.Client`` (connection pooling, tests).
            Defaults to one-shot ``httpx`` requests.
        timeout: Per-request timeout in seconds when no ``client`` is injected.
    """
    return HttpFacilitator(base_url, api_key, client=client, timeout=timeout)

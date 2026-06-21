"""L402Auth over streaming requests.

The btc-trade SSE use case drives a long-lived ``client.stream("GET", ...)``
through the gateway with ``L402Auth`` attached. These tests pin two
properties of the auth flow:

  1. A STREAMING GET is correctly replayed after the 402, and the
     post-payment body is delivered incrementally (not buffered).
  2. The 402 challenge body is read explicitly, so a body-supplied
     ``amountSats`` is recovered even when the 402 arrives UNREAD over the
     wire (i.e. not pre-buffered like a MockTransport ``json=`` response).
"""

import asyncio

import httpx

from bolthub import L402Auth

URL = "https://gw.example.com/v1/stream"
CHALLENGE = {"WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbc1u1pstream"'}
FRAMES = [f"event: tick\ndata: {i}\n\n".encode() for i in range(3)]


class MockWallet:
    def pay_invoice(self, bolt11: str) -> str:
        return "pre"


class AsyncMockWallet:
    async def pay_invoice(self, bolt11: str) -> str:
        return "apre"


class _SyncBytes(httpx.SyncByteStream):
    def __init__(self, chunks, produced=None):
        self._chunks = chunks
        self._produced = produced

    def __iter__(self):
        for i, c in enumerate(self._chunks):
            if self._produced is not None:
                self._produced.append(i)
            yield c


class _AsyncBytes(httpx.AsyncByteStream):
    def __init__(self, chunks, produced=None):
        self._chunks = chunks
        self._produced = produced

    async def __aiter__(self):
        for i, c in enumerate(self._chunks):
            if self._produced is not None:
                self._produced.append(i)
            yield c


# ----------------------------------------------------- streaming GET replay

def test_sync_streaming_get_replays_after_402_incrementally():
    produced: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization", "").startswith("L402 "):
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=_SyncBytes(FRAMES, produced),
            )
        return httpx.Response(402, headers=CHALLENGE, json={"amountSats": 10})

    auth = L402Auth(MockWallet(), budget_sats=1000)
    received: list[str] = []
    with httpx.Client(auth=auth, transport=httpx.MockTransport(handler)) as client:
        with client.stream("GET", URL) as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            # The post-payment stream must NOT be drained during the auth
            # flow — nothing produced until we actively consume.
            assert produced == []
            for chunk in resp.iter_bytes():
                received.append(chunk.decode())

    assert "".join(received) == "".join(f.decode() for f in FRAMES)
    assert auth.total_spent == 10


def test_async_streaming_get_replays_after_402_incrementally():
    produced: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization", "").startswith("L402 "):
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=_AsyncBytes(FRAMES, produced),
            )
        return httpx.Response(402, headers=CHALLENGE, json={"amountSats": 10})

    auth = L402Auth(AsyncMockWallet(), budget_sats=1000)

    async def go() -> list[str]:
        received: list[str] = []
        async with httpx.AsyncClient(
            auth=auth, transport=httpx.MockTransport(handler)
        ) as client:
            async with client.stream("GET", URL) as resp:
                assert resp.status_code == 200
                assert produced == []
                async for chunk in resp.aiter_bytes():
                    received.append(chunk.decode())
        return received

    received = asyncio.run(go())
    assert "".join(received) == "".join(f.decode() for f in FRAMES)
    assert auth.total_spent == 10


# ------------------------------------------------ explicit unread-402 read

def test_sync_reads_unread_402_body():
    # 402 arrives UNREAD (stream=, not json=). The price lives only in the
    # body (the invoice is non-decodable), so it is recovered only because
    # sync_auth_flow reads the challenge response explicitly.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization", "").startswith("L402 "):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(
            402,
            headers={"WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbcplaceholder"'},
            stream=_SyncBytes([b'{"amountSats": 30}']),
        )

    auth = L402Auth(MockWallet(), budget_sats=1000)
    with httpx.Client(auth=auth, transport=httpx.MockTransport(handler)) as client:
        resp = client.get(URL)
    assert resp.status_code == 200
    assert auth.total_spent == 30


def test_async_reads_unread_402_body():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization", "").startswith("L402 "):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(
            402,
            headers={"WWW-Authenticate": 'L402 macaroon="mac", invoice="lnbcplaceholder"'},
            stream=_AsyncBytes([b'{"amountSats": 30}']),
        )

    auth = L402Auth(AsyncMockWallet(), budget_sats=1000)

    async def go() -> httpx.Response:
        async with httpx.AsyncClient(
            auth=auth, transport=httpx.MockTransport(handler)
        ) as client:
            return await client.get(URL)

    resp = asyncio.run(go())
    assert resp.status_code == 200
    assert auth.total_spent == 30

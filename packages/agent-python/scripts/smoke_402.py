"""Smoke test the L402 flow against a REAL local HTTP server.

Spins up a tiny WSGI gateway that answers `402` with an L402 challenge and `200`
once an `Authorization: L402 ...` header is present, then drives the sync client,
the async client, and an L402Auth-backed httpx client against it over TCP.

    python scripts/smoke_402.py
"""

import asyncio
import threading
from wsgiref.simple_server import make_server

import httpx

from bolthub import AsyncL402Client, L402Auth, L402Client

# lnbc10n -> 10 nano-BTC = 1 sat; body amountSats agrees.
CHALLENGE = 'L402 macaroon="mac123", invoice="lnbc10n1ptest"'


def app(environ, start_response):
    if environ.get("HTTP_AUTHORIZATION", "").startswith("L402 "):
        start_response("200 OK", [("Content-Type", "application/json")])
        return [b'{"ok": true}']
    start_response(
        "402 Payment Required",
        [("Content-Type", "application/json"), ("WWW-Authenticate", CHALLENGE)],
    )
    return [b'{"amountSats": 1}']


class MockWallet:
    def __init__(self):
        self.calls = 0

    def pay_invoice(self, bolt11: str) -> str:
        self.calls += 1
        return "preimage-hex"


def run_server():
    server = make_server("127.0.0.1", 0, app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1/data"


def check(label, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        raise SystemExit(1)


def main():
    server, url = run_server()
    try:
        # 1) sync client
        c = L402Client(MockWallet(), budget_sats=100)
        r = c.get(url)
        check(f"sync L402Client -> {r.status_code}, spent={c.total_spent}", r.status_code == 200 and c.total_spent == 1)
        c.close()

        # 2) async client
        async def go():
            async with AsyncL402Client(MockWallet(), budget_sats=100) as ac:
                resp = await ac.get(url)
                return resp.status_code, ac.total_spent

        status, spent = asyncio.run(go())
        check(f"AsyncL402Client -> {status}, spent={spent}", status == 200 and spent == 1)

        # 3) L402Auth on a caller-owned httpx.Client
        auth = L402Auth(MockWallet(), budget_sats=100)
        with httpx.Client(auth=auth) as client:
            r = client.get(url)
        check(f"L402Auth -> {r.status_code}, spent={auth.total_spent}", r.status_code == 200 and auth.total_spent == 1)

        print("\nAll smoke checks passed against a real local 402 server.")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()

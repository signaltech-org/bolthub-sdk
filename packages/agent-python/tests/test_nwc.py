"""P6 — NwcWallet.from_uri (NIP-47) against a mock relay/wallet.

Parsing tests run unconditionally (stdlib only). The round-trip tests require the
optional ``[nwc]`` extra and are skipped otherwise.
"""

import asyncio
import json
import os
import threading
import time

import pytest

from bolthub import NwcWallet, AsyncNwcWallet, L402Error
from bolthub import _nwc, _secp256k1


# --------------------------------------------------------------- URI parsing

class TestParseUri:
    def test_valid_uri(self):
        pub = _secp256k1.pubkey_gen(os.urandom(32)).hex()
        secret = os.urandom(32).hex()
        uri = f"nostr+walletconnect://{pub}?relay=wss://relay.example.com&secret={secret}"
        cfg = _nwc.parse_nwc_uri(uri)
        assert cfg.wallet_pubkey == pub
        assert cfg.relay == "wss://relay.example.com"
        assert cfg.secret == secret

    @pytest.mark.parametrize(
        "uri",
        [
            "https://example.com",  # wrong scheme
            "nostr+walletconnect://zz?relay=wss://r&secret=" + "0" * 64,  # bad pubkey
            "nostr+walletconnect://" + "0" * 64 + "?secret=" + "0" * 64,  # missing relay
            "nostr+walletconnect://" + "0" * 64 + "?relay=wss://r",  # missing secret
        ],
    )
    def test_invalid_uri(self, uri):
        with pytest.raises(L402Error):
            _nwc.parse_nwc_uri(uri)


# --------------------------------------------------------------- mock relay

def _build_wallet_response(req_event, wallet_secret_hex, preimage, error_code=None):
    wallet_sk = bytes.fromhex(wallet_secret_hex)
    wallet_pub = _secp256k1.pubkey_gen(wallet_sk).hex()
    client_pub = req_event["pubkey"]
    shared = _secp256k1.ecdh_x(wallet_sk, bytes.fromhex(client_pub))
    if error_code:
        payload = {"result_type": "pay_invoice", "error": {"code": error_code, "message": "no"}}
    else:
        payload = {"result_type": "pay_invoice", "result": {"preimage": preimage}}
    event = {
        "pubkey": wallet_pub,
        "created_at": int(time.time()),
        "kind": _nwc.NWC_RESPONSE_KIND,
        "tags": [["p", client_pub], ["e", req_event["id"]]],
        "content": _nwc._nip04_encrypt(json.dumps(payload), shared),
    }
    event["id"] = _nwc._event_id(event)
    event["sig"] = _secp256k1.schnorr_sign(bytes.fromhex(event["id"]), wallet_sk, os.urandom(32)).hex()
    return event


class MockRelay:
    """A websockets server acting as both relay and NWC wallet."""

    def __init__(self, wallet_secret, preimage, error_code=None):
        self.wallet_secret = wallet_secret
        self.preimage = preimage
        self.error_code = error_code
        self.received_invoice = None
        self._server = None
        self._thread = None

    def _handler(self, ws):
        sub = None
        for raw in ws:
            msg = json.loads(raw)
            if msg[0] == "REQ":
                sub = msg[1]
            elif msg[0] == "EVENT":
                req = msg[1]
                # Decrypt the request to confirm the method + capture the invoice.
                shared = _secp256k1.ecdh_x(
                    bytes.fromhex(self.wallet_secret), bytes.fromhex(req["pubkey"])
                )
                inner = json.loads(_nwc._nip04_decrypt(req["content"], shared))
                self.received_invoice = inner["params"]["invoice"]
                resp = _build_wallet_response(
                    req, self.wallet_secret, self.preimage, self.error_code
                )
                if sub:
                    ws.send(json.dumps(["EVENT", sub, resp]))
                ws.send(json.dumps(["OK", req["id"], True, ""]))

    def __enter__(self):
        from websockets.sync.server import serve

        self._server = serve(self._handler, "127.0.0.1", 0)
        self.port = self._server.socket.getsockname()[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args):
        self._server.shutdown()

    def uri(self, client_secret):
        wallet_pub = _secp256k1.pubkey_gen(bytes.fromhex(self.wallet_secret)).hex()
        return (
            f"nostr+walletconnect://{wallet_pub}"
            f"?relay=ws://127.0.0.1:{self.port}&secret={client_secret}"
        )


@pytest.fixture
def _require_nwc():
    pytest.importorskip("websockets")
    pytest.importorskip("cryptography")


class TestNwcRoundTrip:
    def test_sync_pays(self, _require_nwc):
        wallet_secret = os.urandom(32).hex()
        client_secret = os.urandom(32).hex()
        preimage = "ab" * 32
        with MockRelay(wallet_secret, preimage) as relay:
            wallet = NwcWallet.from_uri(relay.uri(client_secret), timeout=5)
            assert wallet.pay_invoice("lnbc1u1ptest") == preimage
            assert relay.received_invoice == "lnbc1u1ptest"

    def test_async_pays(self, _require_nwc):
        wallet_secret = os.urandom(32).hex()
        client_secret = os.urandom(32).hex()
        preimage = "cd" * 32
        with MockRelay(wallet_secret, preimage) as relay:
            wallet = AsyncNwcWallet.from_uri(relay.uri(client_secret), timeout=5)
            result = asyncio.run(wallet.pay_invoice("lnbc2u1ptest"))
            assert result == preimage
            assert relay.received_invoice == "lnbc2u1ptest"

    def test_wallet_error_maps_to_l402error(self, _require_nwc):
        wallet_secret = os.urandom(32).hex()
        client_secret = os.urandom(32).hex()
        with MockRelay(wallet_secret, "00" * 32, error_code="INSUFFICIENT_BALANCE") as relay:
            wallet = NwcWallet.from_uri(relay.uri(client_secret), timeout=5)
            with pytest.raises(L402Error, match="INSUFFICIENT_BALANCE"):
                wallet.pay_invoice("lnbc1u1ptest")

    def test_works_with_l402_client(self, _require_nwc):
        # End-to-end: NWC wallet drives an L402Client payment via MockTransport.
        import httpx
        from bolthub import L402Client

        wallet_secret = os.urandom(32).hex()
        client_secret = os.urandom(32).hex()
        preimage = "ef" * 32

        def handler(request):
            if request.headers.get("authorization", "").startswith("L402 "):
                return httpx.Response(200, json={"ok": True})
            return httpx.Response(
                402,
                headers={"WWW-Authenticate": 'L402 macaroon="m", invoice="lnbc10n1ptest"'},
                json={"amountSats": 1},
            )

        with MockRelay(wallet_secret, preimage) as relay:
            wallet = NwcWallet.from_uri(relay.uri(client_secret), timeout=5)
            client = L402Client(wallet, budget_sats=100)
            client._client = httpx.Client(transport=httpx.MockTransport(handler))
            try:
                assert client.get("https://gw.example.com/x").status_code == 200
                assert client.total_spent == 1
            finally:
                client.close()

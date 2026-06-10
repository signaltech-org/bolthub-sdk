import pytest
from unittest.mock import patch, MagicMock

from bolthub import LndWallet, LnbitsWallet, PhoenixdWallet, NwcWallet


class TestLndWallet:
    def test_pays_invoice(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"result": {"payment_preimage": "abc123"}}

        with patch("bolthub.wallets.httpx.post", return_value=mock_resp) as mock_post:
            wallet = LndWallet(host="https://lnd.example.com:8080", macaroon="deadbeef")
            preimage = wallet.pay_invoice("lnbc1000...")

        assert preimage == "abc123"
        mock_post.assert_called_once()
        call_args = mock_post.call_args
        assert "/v2/router/send" in call_args[0][0]
        assert call_args[1]["headers"]["Grpc-Metadata-macaroon"] == "deadbeef"

    def test_strips_trailing_slash(self):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"result": {"payment_preimage": "ok"}}

        with patch("bolthub.wallets.httpx.post", return_value=mock_resp) as mock_post:
            wallet = LndWallet(host="https://lnd.example.com/", macaroon="m")
            wallet.pay_invoice("lnbc...")

        url = mock_post.call_args[0][0]
        assert url == "https://lnd.example.com/v2/router/send"

    def test_raises_on_missing_preimage(self):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"result": {}}

        with patch("bolthub.wallets.httpx.post", return_value=mock_resp):
            wallet = LndWallet(host="https://lnd.example.com", macaroon="m")
            with pytest.raises(RuntimeError, match="missing preimage"):
                wallet.pay_invoice("lnbc...")


class TestLnbitsWallet:
    def test_pays_invoice(self):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"preimage": "lnbits_pre"}

        with patch("bolthub.wallets.httpx.post", return_value=mock_resp) as mock_post:
            wallet = LnbitsWallet(url="https://lnbits.example.com", admin_key="key1")
            preimage = wallet.pay_invoice("lnbc500...")

        assert preimage == "lnbits_pre"
        assert mock_post.call_args[1]["headers"]["X-Api-Key"] == "key1"

    def test_accepts_payment_preimage_field(self):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"payment_preimage": "alt"}

        with patch("bolthub.wallets.httpx.post", return_value=mock_resp):
            wallet = LnbitsWallet(url="https://lnbits.example.com", admin_key="k")
            assert wallet.pay_invoice("lnbc...") == "alt"


class TestPhoenixdWallet:
    def test_pays_invoice(self):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"paymentPreimage": "phx_pre"}

        with patch("bolthub.wallets.httpx.post", return_value=mock_resp) as mock_post:
            wallet = PhoenixdWallet(url="http://localhost:9740", password="pass")
            preimage = wallet.pay_invoice("lnbc300...")

        assert preimage == "phx_pre"
        assert "Basic" in mock_post.call_args[1]["headers"]["Authorization"]

    def test_raises_on_missing_preimage(self):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {}

        with patch("bolthub.wallets.httpx.post", return_value=mock_resp):
            wallet = PhoenixdWallet(url="http://localhost:9740", password="p")
            with pytest.raises(RuntimeError, match="missing preimage"):
                wallet.pay_invoice("lnbc...")


class TestNwcWallet:
    def test_delegates_to_pay_fn(self):
        pay_fn = MagicMock(return_value="nwc_pre")
        wallet = NwcWallet(pay_fn=pay_fn)
        result = wallet.pay_invoice("lnbc...")

        assert result == "nwc_pre"
        pay_fn.assert_called_once_with("lnbc...")

    def test_propagates_errors(self):
        pay_fn = MagicMock(side_effect=RuntimeError("NWC error"))
        wallet = NwcWallet(pay_fn=pay_fn)

        with pytest.raises(RuntimeError, match="NWC error"):
            wallet.pay_invoice("lnbc...")

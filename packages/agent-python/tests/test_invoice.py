import pytest

from bolthub._invoice import bolt11_amount_sats


class TestBolt11AmountSats:
    @pytest.mark.parametrize(
        "invoice,expected",
        [
            # <amount><multiplier> on each network, with a bech32 separator + data.
            ("lnbc2500u1pvjluezpp5abc", 250_000),   # 2500 micro-BTC
            ("lnbc10m1pdata", 1_000_000),           # 10 milli-BTC
            ("lnbc50n1pdata", 5),                    # 50 nano-BTC = 5 sats
            ("lnbc20000n1pdata", 2_000),             # 20000 nano-BTC = 2000 sats
            ("lntb500u1pdata", 50_000),              # testnet
            ("lntbs100n1pdata", 10),                 # signet
            ("lnbcrt30u1pdata", 3_000),              # regtest
            ("LNBC2500U1PDATA", 250_000),            # case-insensitive
        ],
    )
    def test_decodes_amounts(self, invoice, expected):
        assert bolt11_amount_sats(invoice) == expected

    @pytest.mark.parametrize(
        "invoice",
        [
            "lnbc1pvjluezpp5data",   # amountless: the '1' is the bech32 separator
            "lntb1pdata",            # amountless testnet
            "",                      # empty
            "not-an-invoice",        # garbage
            "lnbc",                  # no separator, no amount
            "lnbc2500u",             # no separator at all
            "lnbc100x1data",         # invalid multiplier
            "lnxx100u1data",         # unknown network prefix
        ],
    )
    def test_undeterminable_returns_none(self, invoice):
        assert bolt11_amount_sats(invoice) is None

    def test_sub_sat_rounds_to_nearest(self):
        # 5 pico-BTC = 0.0005 sat -> rounds to 0 -> treated as undeterminable.
        assert bolt11_amount_sats("lnbc5p1data") is None
        # 15000 pico-BTC = 1.5 sat -> rounds half-up to 2.
        assert bolt11_amount_sats("lnbc15000p1data") == 2

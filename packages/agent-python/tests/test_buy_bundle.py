"""Prepaid bundles are retired: buy_bundle raises and pays nothing."""

import asyncio

import pytest

from bolthub import AsyncL402Client, L402Client, L402Error


class _Wallet:
    def __init__(self):
        self.paid = 0

    def pay_invoice(self, bolt11: str) -> str:
        self.paid += 1
        return "beef"


class _AsyncWallet:
    def __init__(self):
        self.paid = 0

    async def pay_invoice(self, bolt11: str) -> str:
        self.paid += 1
        return "beef"


def test_buy_bundle_retired_raises_and_pays_nothing():
    w = _Wallet()
    client = L402Client(w, budget_sats=10_000)
    with pytest.raises(L402Error, match="retired"):
        client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)
    assert w.paid == 0
    assert client.total_spent == 0


def test_async_buy_bundle_retired_raises_and_pays_nothing():
    w = _AsyncWallet()
    client = AsyncL402Client(w, budget_sats=10_000)

    async def go():
        with pytest.raises(L402Error, match="retired"):
            await client.buy_bundle("https://acme.gw.bolthub.ai/v1/data", 100)

    asyncio.run(go())
    assert w.paid == 0
    assert client.total_spent == 0

"""Asynchronous L402 client for asyncio / FastAPI hosts.

    python examples/async_client.py

A synchronous wallet (LndWallet) works under the async client unchanged — it is
run in a worker thread. Use AsyncLndWallet for a fully non-blocking path.
"""

import asyncio

from bolthub import AsyncL402Client, LndWallet


async def main() -> None:
    wallet = LndWallet(host="https://your-lnd-node:8080", macaroon="admin-macaroon-hex")
    async with AsyncL402Client(wallet, budget_sats=10_000) as client:
        resp = await client.get("https://acme.gw.bolthub.ai/v1/market-data")
        resp.raise_for_status()
        print(resp.json())
        print(f"spent={client.total_spent} sats")


if __name__ == "__main__":
    asyncio.run(main())

"""Plug L402 into your own httpx client with L402Auth.

    python examples/httpx_auth.py

Use this when you want to keep your own httpx client (its transport, pooling, and
retries) and just add L402 payment. Works with httpx.Client and AsyncClient.
"""

import httpx

from bolthub import L402Auth, LndWallet

wallet = LndWallet(host="https://your-lnd-node:8080", macaroon="admin-macaroon-hex")
auth = L402Auth(wallet, budget_sats=10_000, max_per_request_sats=100)

with httpx.Client(auth=auth, timeout=30) as client:
    resp = client.get("https://acme.gw.bolthub.ai/v1/market-data")
    resp.raise_for_status()
    print(resp.json())

print(f"spent={auth.total_spent} sats, remaining={auth.remaining_budget} sats")


# Async variant — the same auth instance backs an AsyncClient:
#
#   async with httpx.AsyncClient(auth=auth) as client:
#       resp = await client.get("https://acme.gw.bolthub.ai/v1/market-data")

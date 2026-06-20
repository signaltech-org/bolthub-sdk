"""Synchronous L402 client: pay-per-call against a paywalled API.

    python examples/sync_client.py
"""

from bolthub import L402Client, LndWallet

wallet = LndWallet(host="https://your-lnd-node:8080", macaroon="admin-macaroon-hex")

# budget_sats caps lifetime spend; max_per_request_sats caps any single invoice.
client = L402Client(wallet, budget_sats=10_000, max_per_request_sats=100)

resp = client.get("https://acme.gw.bolthub.ai/v1/market-data", params={"symbol": "BTC"})
resp.raise_for_status()
print(resp.json())

print(f"spent={client.total_spent} sats, remaining={client.remaining_budget} sats")
client.close()

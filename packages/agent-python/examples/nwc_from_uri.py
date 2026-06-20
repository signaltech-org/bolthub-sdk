"""Configure a wallet from a Nostr Wallet Connect URI (NIP-47).

Requires the optional extra:

    pip install 'bolthub[nwc]'
    python examples/nwc_from_uri.py

Get a connection URI from CoinOS, Alby Hub, Zeus, Primal, etc. It is the one
wallet you can wire entirely from an environment variable.
"""

import os

from bolthub import L402Client, NwcWallet

# nostr+walletconnect://<wallet_pubkey>?relay=<wss-url>&secret=<hex>
nwc_uri = os.environ["NWC_URI"]

wallet = NwcWallet.from_uri(nwc_uri, timeout=30)
client = L402Client(wallet, budget_sats=10_000)

resp = client.get("https://acme.gw.bolthub.ai/v1/market-data")
resp.raise_for_status()
print(resp.json())
client.close()


# Async hosts use AsyncNwcWallet:
#
#   from bolthub import AsyncL402Client, AsyncNwcWallet
#   wallet = AsyncNwcWallet.from_uri(nwc_uri)
#   async with AsyncL402Client(wallet, budget_sats=10_000) as client:
#       resp = await client.get(...)

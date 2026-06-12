/** List recent transactions on the NWC_URI wallet (payer-side E2E helper). */
import { NWCClient } from "@getalby/sdk";
const nwc = new NWCClient({ nostrWalletConnectUrl: process.env.NWC_URI! });
const res = await nwc.listTransactions({ limit: 30 });
const txs = res.transactions ?? [];
for (const t of txs) {
  const when = new Date((t.settled_at ?? t.created_at) * 1000).toISOString();
  console.log(`${t.type}  ${Math.round(t.amount / 1000)} sats  ${t.state ?? "settled"}  ${when}  ${(t.description ?? "").slice(0, 60)}`);
}
console.log(`---\noutgoing settled: ${txs.filter(t => t.type === "outgoing" && (t.state ? t.state === "settled" : !!t.settled_at)).length}`);
nwc.close?.();

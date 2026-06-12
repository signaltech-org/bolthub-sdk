/** One paid request, fully instrumented: status, headers, body. */
import { NWCClient } from "@getalby/sdk";

const url = process.argv[2] ?? "https://btc-intel.gw.bolthub.ai/v1/history/candles";
const c1 = await fetch(url);
const challenge = await c1.json();
console.log("challenge:", c1.status, JSON.stringify(challenge).slice(0, 120));
const macaroon = /macaroon="([^"]+)"/.exec(c1.headers.get("www-authenticate") ?? "")?.[1];

const nwc = new NWCClient({ nostrWalletConnectUrl: process.env.NWC_URI! });
const { preimage } = await nwc.payInvoice({ invoice: challenge.paymentRequest });
console.log("paid, preimage:", preimage.slice(0, 16) + "…");

const t = performance.now();
const r = await fetch(url, { headers: { Authorization: `L402 ${macaroon}:${preimage}` } });
console.log(`\nfinal: HTTP ${r.status} in ${Math.round(performance.now() - t)}ms`);
r.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
const body = await r.text();
console.log(`body (${body.length}B):`, body.slice(0, 300));
nwc.close?.();

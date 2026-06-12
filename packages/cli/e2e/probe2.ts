/** Paid probe with Accept-Encoding: identity — raw bytes, no decompression. */
import { NWCClient } from "@getalby/sdk";
const url = process.argv[2] ?? "https://btc-intel.gw.bolthub.ai/v1/history/candles";
const c1 = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
const challenge = await c1.json();
const macaroon = /macaroon="([^"]+)"/.exec(c1.headers.get("www-authenticate") ?? "")?.[1];
const nwc = new NWCClient({ nostrWalletConnectUrl: process.env.NWC_URI! });
const { preimage } = await nwc.payInvoice({ invoice: challenge.paymentRequest });
const r = await fetch(url, {
  headers: { Authorization: `L402 ${macaroon}:${preimage}`, "Accept-Encoding": "identity" },
});
console.log(`final: HTTP ${r.status}`);
console.log(`  content-encoding: ${r.headers.get("content-encoding")}  content-length: ${r.headers.get("content-length")}  x-cache: ${r.headers.get("x-cache")} age: ${r.headers.get("x-cache-age")}`);
const buf = new Uint8Array(await r.arrayBuffer());
console.log(`actual bytes received: ${buf.length}`);
console.log("body[0..200]:", new TextDecoder().decode(buf.slice(0, 200)));
nwc.close?.();

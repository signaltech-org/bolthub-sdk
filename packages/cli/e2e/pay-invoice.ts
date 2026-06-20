/** Pay one BOLT11 invoice via NWC_URI; print the preimage. E2E helper. */
import { NWCClient } from "@getalby/sdk";
const nwc = new NWCClient({ nostrWalletConnectUrl: process.env.NWC_URI! });
const { preimage } = await nwc.payInvoice({ invoice: process.argv[2] });
console.log(preimage);
nwc.close?.();

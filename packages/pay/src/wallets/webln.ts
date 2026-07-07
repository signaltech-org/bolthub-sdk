import type { WalletAdapter } from "../http/types";

declare global {
  interface Window {
    webln?: {
      enable(): Promise<void>;
      sendPayment(paymentRequest: string): Promise<{ preimage: string }>;
    };
  }
}

/**
 * Browser-only wallet adapter that pays invoices through the WebLN provider
 * injected by extensions like Alby. Calls `window.webln.enable()` before
 * each payment.
 */
export class WebLnWallet implements WalletAdapter {
  async payInvoice(bolt11: string): Promise<{ preimage: string }> {
    if (typeof window === "undefined" || !window.webln) {
      throw new Error("WebLN is not available in this environment");
    }
    await window.webln.enable();
    const { preimage } = await window.webln.sendPayment(bolt11);
    return { preimage };
  }
}

/** Returns `true` if a WebLN provider is available in the current environment. */
export function isWebLnAvailable(): boolean {
  return typeof window !== "undefined" && !!window.webln;
}

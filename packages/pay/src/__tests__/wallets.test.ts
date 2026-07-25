import { describe, test, expect, mock, afterEach } from "bun:test";
import { LndWallet } from "../wallets/lnd";
import { LnbitsWallet } from "../wallets/lnbits";
import { PhoenixdWallet } from "../wallets/phoenixd";
import { NwcWallet } from "../wallets/nwc";
import type { NwcConnection } from "../wallets/nwc";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LndWallet", () => {
  test("pays invoice via LND REST API", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    globalThis.fetch = mock(async (url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
      capturedBody = init.body;
      return new Response(
        JSON.stringify({ result: { payment_preimage: "a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1" } }),
        { status: 200 },
      );
    }) as any;

    const wallet = new LndWallet({
      host: "https://lnd.example.com:8080",
      macaroon: "deadbeef",
      timeoutSeconds: 15,
    });

    const result = await wallet.payInvoice("lnbc1000...");

    expect(result.preimage).toBe("a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1a5c1");
    expect(capturedUrl).toBe("https://lnd.example.com:8080/v2/router/send");
    expect(capturedHeaders["grpc-metadata-macaroon"]).toBe("deadbeef");
    expect(JSON.parse(capturedBody)).toEqual({
      payment_request: "lnbc1000...",
      timeout_seconds: 15,
    });
  });

  test("strips trailing slash from host", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ result: { payment_preimage: "ok" } }),
        { status: 200 },
      );
    }) as any;

    const wallet = new LndWallet({
      host: "https://lnd.example.com/",
      macaroon: "deadbeef",
    });
    await wallet.payInvoice("lnbc...");
    expect(capturedUrl).toBe("https://lnd.example.com/v2/router/send");
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = mock(async () =>
      new Response("forbidden", { status: 403 }),
    ) as any;

    const wallet = new LndWallet({ host: "https://lnd.example.com", macaroon: "x" });
    await expect(wallet.payInvoice("lnbc...")).rejects.toThrow("LND payment failed (403)");
  });

  test("throws when preimage is missing from response", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    ) as any;

    const wallet = new LndWallet({ host: "https://lnd.example.com", macaroon: "x" });
    await expect(wallet.payInvoice("lnbc...")).rejects.toThrow("missing preimage");
  });
});

describe("LnbitsWallet", () => {
  test("pays invoice via LNbits API", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = mock(async (url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
      return new Response(
        JSON.stringify({ preimage: "lnbits_preimage" }),
        { status: 200 },
      );
    }) as any;

    const wallet = new LnbitsWallet({
      url: "https://lnbits.example.com",
      adminKey: "admin123",
    });

    const result = await wallet.payInvoice("lnbc500...");

    expect(result.preimage).toBe("lnbits_preimage");
    expect(capturedUrl).toBe("https://lnbits.example.com/api/v1/payments");
    expect(capturedHeaders["x-api-key"]).toBe("admin123");
  });

  test("accepts payment_preimage field", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ payment_preimage: "alt" }), { status: 200 }),
    ) as any;

    const wallet = new LnbitsWallet({ url: "https://lnbits.example.com", adminKey: "k" });
    const result = await wallet.payInvoice("lnbc...");
    expect(result.preimage).toBe("alt");
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = mock(async () =>
      new Response("error", { status: 500 }),
    ) as any;

    const wallet = new LnbitsWallet({ url: "https://lnbits.example.com", adminKey: "k" });
    await expect(wallet.payInvoice("lnbc...")).rejects.toThrow("LNbits payment failed (500)");
  });
});

describe("PhoenixdWallet", () => {
  test("pays invoice via Phoenixd API", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    globalThis.fetch = mock(async (url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
      capturedBody = init.body instanceof URLSearchParams ? init.body.toString() : init.body;
      return new Response(
        JSON.stringify({ paymentPreimage: "phx_preimage" }),
        { status: 200 },
      );
    }) as any;

    const wallet = new PhoenixdWallet({
      baseUrl: "http://localhost:9740",
      password: "mypass",
    });

    const result = await wallet.payInvoice("lnbc300...");

    expect(result.preimage).toBe("phx_preimage");
    expect(capturedUrl).toBe("http://localhost:9740/payinvoice");
    expect(capturedHeaders["authorization"]).toContain("Basic");
    expect(capturedBody).toContain("lnbc300...");
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = mock(async () =>
      new Response("bad", { status: 400 }),
    ) as any;

    const wallet = new PhoenixdWallet({ baseUrl: "http://localhost:9740", password: "p" });
    await expect(wallet.payInvoice("lnbc...")).rejects.toThrow("Phoenixd payment failed (400)");
  });
});

describe("NwcWallet", () => {
  test("delegates to the NWC connection", async () => {
    const connection: NwcConnection = {
      payInvoice: mock(async () => ({ preimage: "nwc_preimage" })),
    };

    const wallet = new NwcWallet(connection);
    const result = await wallet.payInvoice("lnbc...");

    expect(result.preimage).toBe("nwc_preimage");
    expect(connection.payInvoice).toHaveBeenCalledWith("lnbc...");
  });

  test("propagates errors from connection", async () => {
    const connection: NwcConnection = {
      payInvoice: mock(async () => { throw new Error("NWC error"); }),
    };

    const wallet = new NwcWallet(connection);
    await expect(wallet.payInvoice("lnbc...")).rejects.toThrow("NWC error");
  });
});

// F11 (2026-07-25 smoke): the payer side must be inspectable.
describe("diagnose", () => {
  test("NwcWallet reports permissions, balance and identity from the connection probes", async () => {
    const connection: NwcConnection = {
      payInvoice: async () => ({ preimage: "x" }),
      walletPubkey: "03abc",
      getBalance: async () => ({ balanceSats: 1353 }),
      getInfo: async () => ({
        alias: "Test Wallet",
        network: "mainnet",
        methods: ["get_info", "get_balance", "make_invoice"],
      }),
    };
    const d = await new NwcWallet(connection).diagnose();
    expect(d.kind).toBe("nwc");
    expect(d.balanceSats).toBe(1353);
    expect(d.alias).toBe("Test Wallet");
    expect(d.pubkey).toBe("03abc");
    // The receive-only connection case: pay_invoice absent from methods
    // must read as a POSITIVE "cannot pay".
    expect(d.canPayInvoices).toBe(false);
  });

  test("NwcWallet reports canPayInvoices true when pay_invoice is permitted", async () => {
    const connection: NwcConnection = {
      payInvoice: async () => ({ preimage: "x" }),
      getInfo: async () => ({ methods: ["pay_invoice", "get_balance"] }),
    };
    const d = await new NwcWallet(connection).diagnose();
    expect(d.canPayInvoices).toBe(true);
  });

  test("NwcWallet degrades failed probes into limitations, never throws", async () => {
    const connection: NwcConnection = {
      payInvoice: async () => ({ preimage: "x" }),
      getBalance: async () => { throw new Error("RESTRICTED"); },
      getInfo: async () => { throw new Error("reply timeout"); },
    };
    const d = await new NwcWallet(connection).diagnose();
    expect(d.canPayInvoices).toBeUndefined();
    expect(d.limitations?.length).toBe(2);
  });

  test("NwcWallet with a payInvoice-only connection reports the missing probes", async () => {
    const connection: NwcConnection = { payInvoice: async () => ({ preimage: "x" }) };
    const d = await new NwcWallet(connection).diagnose();
    expect(d.limitations?.[0]).toContain("payInvoice only");
  });

  test("LndWallet reads channel balance and identity", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.endsWith("/v1/balance/channels")) {
        return new Response(JSON.stringify({ balance: "9000", local_balance: { sat: "8500" } }), { status: 200 });
      }
      if (url.endsWith("/v1/getinfo")) {
        return new Response(
          JSON.stringify({ alias: "my-node", identity_pubkey: "02def", chains: [{ chain: "bitcoin", network: "mainnet" }] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as any;

    const d = await new LndWallet({ host: "https://lnd.example.com", macaroon: "m" }).diagnose();
    expect(d.kind).toBe("lnd");
    expect(d.balanceSats).toBe(8500); // local (spendable) side, not total
    expect(d.alias).toBe("my-node");
    expect(d.pubkey).toBe("02def");
    expect(d.network).toBe("mainnet");
  });

  test("LndWallet turns refused probes into limitations (restricted macaroon)", async () => {
    globalThis.fetch = mock(async () => new Response("permission denied", { status: 403 })) as any;
    const d = await new LndWallet({ host: "https://lnd.example.com", macaroon: "m" }).diagnose();
    expect(d.balanceSats).toBeUndefined();
    expect(d.limitations?.length).toBe(2);
    expect(d.limitations?.[0]).toContain("403");
  });

  test("LnbitsWallet converts millisat balance to sats", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ name: "spend-wallet", balance: 1353000 }), { status: 200 }),
    ) as any;
    const d = await new LnbitsWallet({ url: "https://lnbits.example.com", adminKey: "k" }).diagnose();
    expect(d.kind).toBe("lnbits");
    expect(d.balanceSats).toBe(1353);
    expect(d.alias).toBe("spend-wallet");
  });

  test("PhoenixdWallet reads balanceSat", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ balanceSat: 777, feeCreditSat: 0 }), { status: 200 }),
    ) as any;
    const d = await new PhoenixdWallet({ baseUrl: "http://localhost:9740", password: "p" }).diagnose();
    expect(d.kind).toBe("phoenixd");
    expect(d.balanceSats).toBe(777);
  });
});

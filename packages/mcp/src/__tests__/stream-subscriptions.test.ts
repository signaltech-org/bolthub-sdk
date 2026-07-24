import { describe, expect, test } from "bun:test";
import { StreamSubscriptionManager } from "../sources/stream-subscriptions";
import type { L402Client } from "@bolthub/pay";

const enc = new TextEncoder();

/**
 * Controllable fake origin: push() emits an SSE frame into the live
 * response; end() closes it. The fake L402Client returns the response
 * and reports a fixed cost via onPaid.
 */
function fakeStream(costSats = 1000) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  const resp = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const client = {
    request: async (_url: string, opts: { onPaid?: (i: { amount: number }) => void }) => {
      opts.onPaid?.({ amount: costSats });
      return resp;
    },
  } as unknown as L402Client;
  return {
    client,
    push: (frame: string) => controller.enqueue(enc.encode(frame)),
    end: () => controller.close(),
    wasCancelled: () => closed,
  };
}

/** Fake client answering with a non-stream response (flag lied / refusal). */
function fakeJsonClient(status = 200): L402Client {
  return {
    request: async () =>
      new Response('{"ok":true}', { status, headers: { "content-type": "application/json" } }),
  } as unknown as L402Client;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("StreamSubscriptionManager", () => {
  test("open pays, pumps events, cursor reads are incremental", async () => {
    const mgr = new StreamSubscriptionManager();
    const origin = fakeStream(750);
    const opened = await mgr.open("https://gw/stream", origin.client);
    if ("error" in opened) throw new Error(opened.error);
    expect(opened.costSats).toBe(750);

    origin.push("data: one\n\n");
    origin.push("data: two\n\n");
    await tick();

    const r1 = await mgr.read(opened.streamId);
    if ("error" in r1) throw new Error(r1.error);
    expect(r1.events.map((e) => e.data)).toEqual(["one", "two"]);
    expect(r1.status).toBe("live");

    const r2 = await mgr.read(opened.streamId);
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.events).toEqual([]);

    origin.push("data: three\n\n");
    await tick();
    const r3 = await mgr.read(opened.streamId);
    if ("error" in r3) throw new Error(r3.error);
    expect(r3.events.map((e) => e.data)).toEqual(["three"]);
    mgr.closeAll();
  });

  test("wait_seconds parks until an event arrives", async () => {
    const mgr = new StreamSubscriptionManager();
    const origin = fakeStream();
    const opened = await mgr.open("https://gw/stream", origin.client);
    if ("error" in opened) throw new Error(opened.error);

    const started = Date.now();
    const pending = mgr.read(opened.streamId, 10);
    setTimeout(() => origin.push("data: woke\n\n"), 50);
    const r = await pending;
    if ("error" in r) throw new Error(r.error);
    expect(r.events.map((e) => e.data)).toEqual(["woke"]);
    // Long-poll returned on the event, not the 10s cap.
    expect(Date.now() - started).toBeLessThan(5000);
    mgr.closeAll();
  });

  test("close cancels the origin socket and returns a summary", async () => {
    const mgr = new StreamSubscriptionManager();
    const origin = fakeStream(500);
    const opened = await mgr.open("https://gw/stream", origin.client);
    if ("error" in opened) throw new Error(opened.error);
    origin.push("data: x\n\n");
    await tick();

    const closed = mgr.close(opened.streamId);
    if ("error" in closed) throw new Error(closed.error);
    expect(closed.summary.totalEvents).toBe(1);
    expect(closed.summary.costSats).toBe(500);
    await tick();
    expect(origin.wasCancelled()).toBe(true);

    const gone = await mgr.read(opened.streamId);
    expect("error" in gone && gone.error).toContain("No such stream");
  });

  test("payment_required terminal frame closes; final read delivers summary once", async () => {
    const mgr = new StreamSubscriptionManager();
    const origin = fakeStream();
    const opened = await mgr.open("https://gw/stream", origin.client);
    if ("error" in opened) throw new Error(opened.error);

    origin.push("data: last\n\n");
    origin.push("event: payment_required\ndata: {}\n\n");
    await tick();

    const r = await mgr.read(opened.streamId);
    if ("error" in r) throw new Error(r.error);
    expect(r.status).toBe("closed");
    expect(r.closeReason).toBe("payment_required");
    expect(r.events.map((e) => e.data)).toEqual(["last"]);

    const gone = await mgr.read(opened.streamId);
    expect("error" in gone).toBe(true);
  });

  test("concurrency cap refuses a 4th stream", async () => {
    const mgr = new StreamSubscriptionManager();
    for (let i = 0; i < 3; i++) {
      const opened = await mgr.open("https://gw/stream", fakeStream().client);
      if ("error" in opened) throw new Error(opened.error);
    }
    const fourth = await mgr.open("https://gw/stream", fakeStream().client);
    expect("error" in fourth && fourth.error).toContain("Stream limit reached");
    mgr.closeAll();
  });

  test("a non-stream response is refused with the HTTP detail", async () => {
    const mgr = new StreamSubscriptionManager();
    const result = await mgr.open("https://gw/not-a-stream", fakeJsonClient());
    expect("error" in result && result.error).toContain("did not open a stream");
    expect(mgr.openCount).toBe(0);
  });

  test("idle reap closes an unread stream", async () => {
    const mgr = new StreamSubscriptionManager({ idleReapMs: 50 });
    const origin = fakeStream();
    const opened = await mgr.open("https://gw/stream", origin.client);
    if ("error" in opened) throw new Error(opened.error);

    await new Promise((r) => setTimeout(r, 120));
    const r = await mgr.read(opened.streamId);
    if ("error" in r) throw new Error(r.error);
    expect(r.status).toBe("closed");
    expect(origin.wasCancelled()).toBe(true);
  });

  test("ring buffer drops oldest and reports the gap to a slow reader", async () => {
    const mgr = new StreamSubscriptionManager();
    const origin = fakeStream();
    const opened = await mgr.open("https://gw/stream", origin.client);
    if ("error" in opened) throw new Error(opened.error);

    for (let i = 0; i < 510; i++) origin.push(`data: e${i}\n\n`);
    await tick();

    const r = await mgr.read(opened.streamId);
    if ("error" in r) throw new Error(r.error);
    expect(r.events).toHaveLength(500);
    expect(r.dropped).toBe(10);
    expect(r.events[0].data).toBe("e10");
    expect(r.events.at(-1)!.data).toBe("e509");
    mgr.closeAll();
  });
});

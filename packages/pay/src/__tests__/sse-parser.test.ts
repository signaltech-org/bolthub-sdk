import { describe, expect, test } from "bun:test";
import { SseParser } from "../http/sse";

describe("SseParser", () => {
  test("parses a complete data frame", () => {
    const p = new SseParser();
    expect(p.push("data: hello\n\n")).toEqual([
      { event: null, data: "hello", id: null, comment: false },
    ]);
  });

  test("buffers partial frames across chunk boundaries", () => {
    const p = new SseParser();
    expect(p.push("event: liquida")).toEqual([]);
    expect(p.push("tion\ndata: {\"sym\":")).toEqual([]);
    expect(p.push("\"BTC\"}\n\ndata: next\n\n")).toEqual([
      { event: "liquidation", data: '{"sym":"BTC"}', id: null, comment: false },
      { event: null, data: "next", id: null, comment: false },
    ]);
  });

  test("joins multi-line data with newlines", () => {
    const p = new SseParser();
    expect(p.push("data: line one\ndata: line two\n\n")).toEqual([
      { event: null, data: "line one\nline two", id: null, comment: false },
    ]);
  });

  test("surfaces comment-only frames as keep-alive ticks", () => {
    const p = new SseParser();
    expect(p.push(": keep-alive\n\n")).toEqual([
      { event: null, data: "", id: null, comment: true },
    ]);
  });

  test("a comment inside a data frame does not mark it as comment", () => {
    const p = new SseParser();
    expect(p.push(": note\ndata: x\n\n")).toEqual([
      { event: null, data: "x", id: null, comment: false },
    ]);
  });

  test("handles CRLF line endings", () => {
    const p = new SseParser();
    expect(p.push("event: tick\r\ndata: 1\r\n\r\n")).toEqual([
      { event: "tick", data: "1", id: null, comment: false },
    ]);
  });

  test("strips exactly one leading space from values", () => {
    const p = new SseParser();
    expect(p.push("data:  two spaces\n\ndata:none\n\n")).toEqual([
      { event: null, data: " two spaces", id: null, comment: false },
      { event: null, data: "none", id: null, comment: false },
    ]);
  });

  test("captures id and event together and ignores retry", () => {
    const p = new SseParser();
    expect(p.push("id: 7\nevent: payment_required\nretry: 100\ndata: end\n\n")).toEqual([
      { event: "payment_required", data: "end", id: "7", comment: false },
    ]);
  });

  test("multiple frames in one chunk", () => {
    const p = new SseParser();
    const frames = p.push("data: a\n\ndata: b\n\ndata: c\n\n");
    expect(frames.map((f) => f.data)).toEqual(["a", "b", "c"]);
  });
});

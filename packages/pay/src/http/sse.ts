/**
 * Incremental Server-Sent-Events parser, shared by the hub's live
 * stream viewer and the MCP's stream tools.
 *
 * Feed it decoded text chunks as they arrive off a `ReadableStream`; it
 * returns the frames COMPLETED by each chunk and buffers any partial frame
 * until the terminating blank line arrives (chunk boundaries never align
 * with frame boundaries in practice). Follows the WHATWG SSE grammar for
 * the fields the viewer needs: `event:`, multi-line `data:` (joined with
 * newlines), `id:`, and `:` comment lines (the gateway's keep-alives),
 * with CRLF tolerance. `retry:` and unknown fields are ignored.
 */

export interface SseFrame {
  /** Event name from `event:`, or null for the default message type. */
  event: string | null;
  /** Data payload; multiple `data:` lines joined with `\n`. */
  data: string;
  /** Last `id:` value seen in the frame, if any. */
  id: string | null;
  /** True for comment-only frames (`: keep-alive` ticks). */
  comment: boolean;
}

export class SseParser {
  private buf = "";

  /** Parse a decoded chunk; returns the frames it completed. */
  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const frames: SseFrame[] = [];

    // A frame ends at a blank line: \n\n (or CRLF variants).
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buf);
      if (!match) break;
      const raw = this.buf.slice(0, match.index);
      this.buf = this.buf.slice(match.index + match[0].length);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  let sawComment = false;

  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line === "") continue;
    if (line.startsWith(":")) {
      sawComment = true;
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per spec a single space after the colon is stripped, further ones kept.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    // retry / unknown fields: ignored.
  }

  if (data.length === 0 && event === null && id === null) {
    // Nothing but comments (or an empty block between separators).
    return sawComment ? { event: null, data: "", id: null, comment: true } : null;
  }
  return { event, data: data.join("\n"), id, comment: false };
}

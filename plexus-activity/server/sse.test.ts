import { describe, expect, it } from "vitest";
import { createSseParser, type SseFrame } from "./sse";

function harness(): {
  frames: SseFrame[];
  push: (text: string) => void;
  pushBytes: (bytes: Uint8Array) => void;
  end: () => void;
} {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  const encoder = new TextEncoder();
  return {
    frames,
    push: (text: string) => parser.push(encoder.encode(text)),
    pushBytes: (bytes: Uint8Array) => parser.push(bytes),
    end: () => parser.end(),
  };
}

describe("createSseParser", () => {
  it("parses a single frame", () => {
    const { frames, push } = harness();
    push('event: started\ndata: {"requestId":"abc"}\nid: 1736942400000\n\n');
    expect(frames).toEqual([
      { event: "started", data: '{"requestId":"abc"}', id: "1736942400000" },
    ]);
  });

  it("parses several frames from one chunk", () => {
    const { frames, push } = harness();
    push("event: ping\ndata: pong\n\nevent: completed\ndata: {}\n\n");
    expect(frames.map((frame) => frame.event)).toEqual(["ping", "completed"]);
    expect(frames[0]?.data).toBe("pong");
  });

  it("reassembles frames split across chunks", () => {
    const { frames, push } = harness();
    push("event: upda");
    push('ted\ndata: {"requestId":"a"}\n');
    expect(frames).toEqual([]);
    push("\n");
    expect(frames).toEqual([{ event: "updated", data: '{"requestId":"a"}', id: null }]);
  });

  it("handles CRLF framing", () => {
    const { frames, push } = harness();
    push("event: ping\r\ndata: pong\r\n\r\n");
    expect(frames).toEqual([{ event: "ping", data: "pong", id: null }]);
  });

  it("joins multi-line data values", () => {
    const { frames, push } = harness();
    push("event: note\ndata: line one\ndata: line two\n\n");
    expect(frames[0]?.data).toBe("line one\nline two");
  });

  it("ignores comments, unknown fields, and retry hints", () => {
    const { frames, push } = harness();
    push(": keepalive\nretry: 5000\nfoo: bar\nevent: ping\ndata: pong\n\n");
    expect(frames).toEqual([{ event: "ping", data: "pong", id: null }]);
  });

  it("splits a multi-byte code point across chunks", () => {
    const { frames, pushBytes } = harness();
    const payload = new TextEncoder().encode('event: updated\ndata: {"model":"café"}\n\n');
    const splitAt = payload.indexOf(0xc3) + 1;
    pushBytes(payload.slice(0, splitAt));
    pushBytes(payload.slice(splitAt));
    expect(frames).toEqual([{ event: "updated", data: '{"model":"café"}', id: null }]);
  });

  it("buffers an incomplete frame until more bytes arrive", () => {
    const { frames, push } = harness();
    push('event: completed\ndata: {"requestId":"z"}');
    expect(frames).toEqual([]);
    push("\n\n");
    expect(frames).toEqual([{ event: "completed", data: '{"requestId":"z"}', id: null }]);
  });

  it("flushes a final unterminated frame on end", () => {
    const { frames, push, end } = harness();
    push("event: ping\ndata: pong");
    expect(frames).toEqual([]);
    end();
    expect(frames).toEqual([{ event: "ping", data: "pong", id: null }]);
  });

  it("skips empty blocks", () => {
    const { frames, push } = harness();
    push("\n\nevent: ping\ndata: pong\n\n");
    expect(frames).toEqual([{ event: "ping", data: "pong", id: null }]);
  });
});

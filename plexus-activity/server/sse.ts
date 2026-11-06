/**
 * Incremental Server-Sent Events parser.
 *
 * Plexus writes UTF-8 frames terminated by a blank line. Network chunks split wherever TCP feels
 * like it — including inside a multi-byte code point — so decoding is streaming and frame buffering is
 * done on strings. `id:` and `retry:` are accepted and ignored: Plexus documents `id` as informational
 * and provides no replay, so it can never be used as a resume cursor.
 */

export interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

export interface SseParser {
  push(chunk: Uint8Array): void;
  /** Flush a trailing frame that was not terminated by a blank line. */
  end(): void;
  reset(): void;
}

interface FrameBoundary {
  readonly index: number;
  readonly length: number;
}

function findFrameBoundary(buffer: string): FrameBoundary | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseFrame(block: string): SseFrame | null {
  let event = "";
  let id: string | null = null;
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
      default:
        break;
    }
  }

  if (dataLines.length === 0 && event === "") return null;
  return { event, data: dataLines.join("\n"), id };
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const flushCompleteFrames = (): void => {
    for (;;) {
      const boundary = findFrameBoundary(buffer);
      if (boundary === null) return;
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const frame = parseFrame(block);
      if (frame !== null) onFrame(frame);
    }
  };

  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      flushCompleteFrames();
    },
    end(): void {
      buffer += decoder.decode();
      if (buffer.trim() !== "") {
        const frame = parseFrame(buffer);
        if (frame !== null) onFrame(frame);
      }
      buffer = "";
      decoder.decode();
    },
    reset(): void {
      buffer = "";
      decoder.decode();
    },
  };
}

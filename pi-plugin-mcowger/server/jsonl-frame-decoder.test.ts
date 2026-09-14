import { describe, expect, test } from "vitest";

import { JsonlFrameDecoder } from "./jsonl-frame-decoder.js";

function harness() {
  const frames: Record<string, unknown>[] = [];
  const problems: string[] = [];
  return {
    frames,
    problems,
    decoder: new JsonlFrameDecoder({
      frame: (frame) => frames.push(frame),
      problem: (problem) => problems.push(problem),
    }),
  };
}

describe("JSONL RPC framing", () => {
  test("retains partial stream frames until their newline arrives", () => {
    const { decoder, frames } = harness();
    decoder.write('{"type":"ready"');
    decoder.write('}\r\n{"type":"event","value":2}\n');
    expect(frames).toEqual([{ type: "ready" }, { type: "event", value: 2 }]);
  });

  test("rejects malformed records without losing the following valid frame", () => {
    const { decoder, frames, problems } = harness();
    decoder.write("not-json\n{\"type\":\"ready\"}\n");
    expect(problems).toEqual(["invalid-json"]);
    expect(frames).toEqual([{ type: "ready" }]);
  });
});

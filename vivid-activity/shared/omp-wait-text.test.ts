import { describe, expect, it } from "vitest";
import { parseOmpWaitText } from "./omp-wait-text";

describe("parseOmpWaitText", () => {
  it("parses multiple result elements and preserves surrounding notice text", () => {
    expect(parseOmpWaitText("task completed: Alpha\n<task-result id=\"a1\" agent=\"task\" status=\"completed\" duration=\"2s\"><output>**Done**</output></task-result>\nNotice\n<task-result id=\"b2\" agent=\"scout\" status=\"failed\"><output>Offline</output></task-result>"))
      .toEqual({
        kind: "result",
        entries: [
          { id: "a1", agent: "task", status: "completed", duration: "2s", metadata: [], output: "**Done**" },
          { id: "b2", agent: "scout", status: "failed", metadata: [], output: "Offline" },
        ],
        remainder: "task completed: Alpha\n\nNotice",
      });
  });

  it("parses multiple running rows and retains unrelated content", () => {
    expect(parseOmpWaitText("## Still Running (2)\n\n- `id-1` [task] — Alpha — 15.3s · 5 req · <$0.01 · ctx 9.4K/1.1M\n- `id-2` [scout] — Beta — 4s · 2 req\n\nTrailing notice"))
      .toEqual({
        kind: "running",
        entries: [
          { id: "id-1", agent: "task", status: "Alpha", duration: "15.3s", metadata: ["5 req", "<$0.01", "ctx 9.4K/1.1M"] },
          { id: "id-2", agent: "scout", status: "Beta", duration: "4s", metadata: ["2 req"] },
        ],
        remainder: "Trailing notice",
      });
  });

  it("returns null for malformed result or running content", () => {
    expect(parseOmpWaitText('<task-result id="x" agent="task"><output>unfinished')).toBeNull();
    expect(parseOmpWaitText("## Still Running (2)\n\n- `id` [task] — Alpha — 1s")).toBeNull();
    expect(parseOmpWaitText("plain text")).toBeNull();
  });
});

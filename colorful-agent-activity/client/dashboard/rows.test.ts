import { describe, expect, it } from "vitest";
import { EXPANSION_TARGETS } from "../../shared/settings";

// The Rows page splits the targets into two buckets of its own; a target added to
// the settings but not to a bucket would silently lose its control.
const COMMON = ["thinking", "read", "edit", "write", "shell", "search", "fetch", "sub_agent", "todo"];
const RARE = ["worktree_setup", "plain_text", "plan", "ask", "speak", "unknown"];

describe("row expansion buckets", () => {
  it("covers every target exactly once", () => {
    const shown = [...COMMON, ...RARE];
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.sort()).toEqual(EXPANSION_TARGETS.map((target) => target.key).sort());
  });
});

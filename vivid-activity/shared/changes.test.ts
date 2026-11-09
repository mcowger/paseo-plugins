import { describe, expect, it } from "vitest";
import { changePath, commandHead, fileId, MAX_CALL_FILES, MAX_PATCH_CHARS, parsePatchText, toolChanges, toolExitCode } from "./changes";
import { diffBlocks } from "./diffstat";
import { diffStatsForDetail, exactDiffStatsForDetail, isCoarseLineDiff, isHostTruncatedDiff, resolveToolCallPresentation } from "./presentation";

const call = (name: string, detail: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: "tool_call", callId: `call_${name}`, name, status: "completed", error: null, detail, ...extra }) as never;
const cwd = "/home/user/demo-app";
const counted = (...files: Array<[string, number, number]>) => ({ files: files.map(([path, added, removed]) => [fileId(path), added, removed]), uncounted: 0 });
const ONE_UNCOUNTED = { files: [], uncounted: 1 };
/** `*** Begin Patch` … `*** End Patch` around the given lines. */
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const patchCall = (text: string) => call("apply_patch", { type: "unknown", input: { patch: text }, output: null });

describe("lines a call changed (0.8.0)", () => {
  it("counts an edit the way its own row does", () => {
    const detail = { type: "edit", filePath: `${cwd}/src/a.ts`, oldString: "one\ntwo\nthree\n", newString: "one\nTWO\nthree\nfour\n" };
    const stats = diffStatsForDetail(detail as never);
    expect(stats).toEqual({ additions: 2, deletions: 1 });
    expect(toolChanges(call("Edit", detail), cwd)).toEqual(counted(["src/a.ts", 2, 1]));
    const diff = { type: "edit", filePath: "src/b.ts", unifiedDiff: "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n keep" };
    expect(toolChanges(call("Edit", diff), cwd)).toEqual(counted(["src/b.ts", 2, 1]));
    // The row shows the same numbers.
    expect(resolveToolCallPresentation({ name: "Edit", detail: diff as never }).diffStats).toEqual({ additions: 2, deletions: 1 });
  });

  it("counts a write, an edit without a diff and a cut-short diff as changes whose lines are not known", () => {
    // A write may have replaced a file of unknown length; an edit without a diff (opencode) has no lines.
    expect(toolChanges(call("Write", { type: "write", filePath: "src/c.ts", content: "a\nb\n" }), cwd)).toEqual(ONE_UNCOUNTED);
    expect(toolChanges(call("edit", { type: "edit", filePath: "src/d.ts" }), cwd)).toEqual(ONE_UNCOUNTED);
    // Paseo keeps the first 12,000 characters of a long diff and says so on a last line.
    const cut = { type: "edit", filePath: "src/big.ts", unifiedDiff: `@@ -1,1 +1,400 @@\n${"+line\n".repeat(400)}\n...[truncated 52000 chars]` };
    expect(isHostTruncatedDiff(cut.unifiedDiff)).toBe(true);
    expect(toolChanges(call("Edit", cut), cwd)).toEqual(ONE_UNCOUNTED);
    expect(exactDiffStatsForDetail(cut as never)).toBeNull();
    expect(resolveToolCallPresentation({ name: "Edit", detail: cut as never }).diffStats).toBeUndefined();
    // Too big to compare: the line diff would count every line of the changed region.
    expect(toolChanges(call("Edit", { type: "edit", filePath: "src/f.ts", oldString: "x".repeat(60_000), newString: "y".repeat(60_000) }), cwd)).toEqual(ONE_UNCOUNTED);
    const before = Array.from({ length: 1500 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 0", "first").replace("line 1499", "last");
    expect(isCoarseLineDiff(before, after)).toBe(true);
    expect(toolChanges(call("Edit", { type: "edit", filePath: "src/g.ts", oldString: before, newString: after }), cwd)).toEqual(ONE_UNCOUNTED);
    expect(isCoarseLineDiff("a\nb\nc", "a\nB\nc")).toBe(false);
  });

  it("leaves out what is not a change", () => {
    const edit = { type: "edit", filePath: "src/e.ts", oldString: "a", newString: "b" };
    expect(toolChanges(call("Edit", edit, { status: "running" }), cwd)).toBeNull();
    expect(toolChanges(call("Edit", edit, { status: "failed" }), cwd)).toBeNull();
    expect(toolChanges(call("Edit", { ...edit, newString: "a" }), cwd)).toBeNull();
    expect(toolChanges(call("Read", { type: "read", filePath: "src/a.ts", content: "x" }), cwd)).toBeNull();
    expect(toolChanges(call("Bash", { type: "shell", command: "ls" }), cwd)).toBeNull();
  });

  it("identifies a file by its path inside the Agent's directory, never the path itself", () => {
    expect(fileId(`${cwd}/src/a.ts`, cwd)).toBe(fileId("src/a.ts", cwd));
    expect(fileId("./src/a.ts", cwd)).toBe(fileId("src/a.ts"));
    expect(fileId("src/a.ts")).not.toBe(fileId("src/b.ts"));
    expect(fileId(`${cwd}/src/a.ts`, cwd)).not.toContain("src");
    expect(changePath(`${cwd}/src/a.ts`, `${cwd}/`)).toBe("src/a.ts");
    expect(changePath("/elsewhere/a.ts", cwd)).toBe("/elsewhere/a.ts");
  });
});

describe("a patch, file by file (0.8.0)", () => {
  it("reads a single-file patch", () => {
    const text = patch("*** Update File: src/app.ts", "@@ export function main() {", "-  return 1;", "+  return 2;", "+  // done", "   }");
    expect(parsePatchText(text)).toEqual([{ path: "src/app.ts", lines: { added: 2, removed: 1 } }]);
    expect(toolChanges(patchCall(text), cwd)).toEqual(counted(["src/app.ts", 2, 1]));
  });

  it("reads every file of a multi-file patch and adds up a file changed twice", () => {
    const text = patch(
      "*** Add File: docs/new.md", "+# New", "+text",
      "*** Update File: src/app.ts", "@@", "-const a = 1;", "+const a = 2;",
      "*** Update File: src/app.ts", "@@", "+export {};",
      "*** Update File: src/old-name.ts", "*** Move to: src/new-name.ts", "@@", "-x", "+y",
    );
    expect(toolChanges(patchCall(text), cwd)).toEqual(counted(["docs/new.md", 2, 0], ["src/app.ts", 2, 1], ["src/new-name.ts", 1, 1]));
  });

  it("counts a deleted file as a change whose lines are not known (the patch does not carry them)", () => {
    const text = patch("*** Delete File: src/legacy.ts", "*** Add File: src/fresh.ts", "+export const fresh = true;");
    expect(parsePatchText(text)).toEqual([{ path: "src/legacy.ts", lines: null }, { path: "src/fresh.ts", lines: { added: 1, removed: 0 } }]);
    expect(toolChanges(patchCall(text), cwd)).toEqual({ files: [[fileId("src/fresh.ts"), 1, 0]], uncounted: 1 });
  });

  it("takes the patch from a string input, an input object or JSON text, and accepts End of File and blank context lines", () => {
    const text = patch("*** Update File: a.txt", "@@", " keep", "", "-old", "+new", "*** End of File");
    const expected = counted(["a.txt", 1, 1]);
    expect(toolChanges(call("apply_patch", { type: "unknown", input: text, output: null }), cwd)).toEqual(expected);
    expect(toolChanges(call("apply_patch", { type: "unknown", input: { input: text }, output: null }), cwd)).toEqual(expected);
    expect(toolChanges(call("apply_patch", { type: "unknown", input: JSON.stringify({ patchText: text }), output: null }), cwd)).toEqual(expected);
  });

  it("counts a patch it cannot read whole as one change whose lines are not known", () => {
    const whole = patch("*** Update File: a.txt", "@@", "-a", "+b", "*** Update File: b.txt", "@@", "-c", "+d");
    // Cut short: no `*** End Patch` (Paseo's truncation, or a text that simply stops).
    const cut = `${whole.slice(0, whole.indexOf("*** Update File: b.txt") + 10)}\n...[truncated 9000 chars]`;
    expect(parsePatchText(cut)).toBeNull();
    expect(toolChanges(patchCall(cut), cwd)).toEqual(ONE_UNCOUNTED);
    // Too long to read.
    const long = patch("*** Add File: big.txt", ...Array.from({ length: MAX_PATCH_CHARS / 8 }, () => "+0123456"));
    expect(long.length).toBeGreaterThan(MAX_PATCH_CHARS);
    expect(toolChanges(patchCall(long), cwd)).toEqual(ONE_UNCOUNTED);
    // A line no section allows, a section without a path, or no section at all.
    expect(parsePatchText(patch("*** Update File: a.txt", "@@", "?? what", "+b"))).toBeNull();
    expect(parsePatchText(patch("*** Add File: a.txt", "not added"))).toBeNull();
    expect(parsePatchText(patch("*** Update File: ", "+b"))).toBeNull();
    expect(parsePatchText(patch("*** Frobnicate File: a.txt"))).toBeNull();
    expect(parsePatchText(patch("stray text", "*** Add File: a.txt", "+a"))).toBeNull();
    expect(parsePatchText(patch())).toBeNull();
    expect(parsePatchText("+just a line")).toBeNull();
    // More files than one call may report.
    const many = patch(...Array.from({ length: MAX_CALL_FILES + 1 }, (_, index) => [`*** Add File: f${index}.txt`, "+x"]).flat());
    expect(parsePatchText(many)).toBeNull();
    expect(toolChanges(patchCall(many), cwd)).toEqual(ONE_UNCOUNTED);
  });

  it("reads a long patch in linear time (no regular expression runs on its lines)", () => {
    // Lines that look like headers once their +/− is read are still content.
    const lines = Array.from({ length: 8_000 }, (_, index) => (index % 2 ? "+" : "-") + "*** Update File: b");
    const text = patch("*** Update File: a.txt", "@@", ...lines);
    expect(text.length).toBeLessThan(MAX_PATCH_CHARS);
    const started = performance.now();
    expect(parsePatchText(text)).toEqual([{ path: "a.txt", lines: { added: 4_000, removed: 4_000 } }]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("does not count a patch Paseo kept only one file of (Codex, ACP), since others may be missing", () => {
    // Paseo turns a Codex fileChange into an edit of its first file only: two files in, one out.
    const firstOnly = { type: "edit", filePath: "src/config.ts", unifiedDiff: "@@ -4,5 +4,7 @@\n-    port: env.PORT ?? 3000,\n+    port: Number(env.PORT ?? 3000),\n+    host: env.HOST\n" };
    expect(toolChanges(call("apply_patch", firstOnly), cwd)).toEqual(ONE_UNCOUNTED);
    // Its own row still shows that file's lines: they are right for the file it names.
    expect(resolveToolCallPresentation({ name: "apply_patch", detail: firstOnly as never }).diffStats).toEqual({ additions: 2, deletions: 1 });
    // A patch call whose content cannot be read at all is still one change.
    expect(toolChanges(call("apply_patch", { type: "unknown", input: null, output: null }), cwd)).toEqual(ONE_UNCOUNTED);
  });

  it("counts OpenCode's per-file patch metadata, each file from its own diff", () => {
    const metadata = { files: [
      { file: "src/a.ts", status: "modified", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c" },
      { file: "src/gone.ts", status: "deleted", patch: "--- a/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y" },
      { file: "src/empty.ts", status: "modified", patch: "" },
    ] };
    expect(toolChanges(call("patch", { type: "edit", filePath: "src/a.ts" }, { metadata }), cwd)).toEqual({
      files: [[fileId("src/a.ts"), 2, 1], [fileId("src/gone.ts"), 0, 2]],
      uncounted: 1,
    });
  });
});

describe("a failed command's exit code (0.8.0)", () => {
  it("reads Codex and ACP exit codes from the detail and Claude Code's from its error", () => {
    expect(toolExitCode(call("exec", { type: "shell", command: "npm test", exitCode: 2 }, { status: "failed" }))).toBe(2);
    expect(toolExitCode(call("Bash", { type: "shell", command: "npm test" }, { status: "failed", error: { type: "tool_result", content: "Exit code 1\n\n> demo@1.0.0 test", is_error: true } }))).toBe(1);
  });

  it("is null for finished, non-shell or silent failures", () => {
    expect(toolExitCode(call("Bash", { type: "shell", command: "ls", exitCode: 0 }))).toBeNull();
    expect(toolExitCode(call("Bash", { type: "shell", command: "ls" }, { status: "failed", error: "Command timed out" }))).toBeNull();
    expect(toolExitCode(call("Edit", { type: "edit", filePath: "a" }, { status: "failed", error: "Exit code 1" }))).toBeNull();
  });

  it("keeps the first line of a command", () => {
    expect(commandHead("  npm test -- --run\n  && echo done  ")).toBe("npm test -- --run");
    expect(commandHead("ls")).toBe("ls");
  });
});

describe("the five-block diffstat (0.8.0)", () => {
  it("shows small changes block for block", () => {
    expect(diffBlocks(0, 0)).toEqual(["none", "none", "none", "none", "none"]);
    expect(diffBlocks(1, 0)).toEqual(["add", "none", "none", "none", "none"]);
    expect(diffBlocks(3, 2)).toEqual(["add", "add", "add", "remove", "remove"]);
    expect(diffBlocks(0, 4)).toEqual(["remove", "remove", "remove", "remove", "none"]);
  });

  it("scales larger changes and keeps a block for each kind present", () => {
    expect(diffBlocks(120, 0)).toEqual(["add", "add", "add", "add", "add"]);
    expect(diffBlocks(0, 120)).toEqual(["remove", "remove", "remove", "remove", "remove"]);
    expect(diffBlocks(120, 4)).toEqual(["add", "add", "add", "add", "remove"]);
    expect(diffBlocks(1, 1000)).toEqual(["add", "remove", "remove", "remove", "remove"]);
    expect(diffBlocks(50, 50)).toEqual(["add", "add", "add", "remove", "remove"]);
  });

  it("ignores counts that are not real numbers", () => {
    expect(diffBlocks(Number.NaN, -3)).toEqual(["none", "none", "none", "none", "none"]);
  });
});

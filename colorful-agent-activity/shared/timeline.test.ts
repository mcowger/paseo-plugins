import { describe, expect, it } from "vitest";
import {
  createTodoData,
  createToolCallData,
  isLatestTaskUpdate,
  resolveExpansion,
  resolveTaskUpdateExpansion,
} from "./timeline";

// Captured from a live opencode v2.0.18 session on daemon 0.10.0 (+PR 5603).
const V2_EDIT_PATCH =
  "Index: /tmp/a.txt\n===================================================================\n--- /tmp/a.txt\n+++ /tmp/a.txt\n@@ -1,4 +1,5 @@\n line one\n line 2 changed\n-line three\n-line four\n+line 3\n+line 4\n+line 5 added\n";

function v2EditItem(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_call" as const,
    callId: "call-1",
    name: "edit",
    status: "completed" as const,
    error: null,
    detail: { type: "edit" as const, filePath: "/tmp/a.txt" },
    metadata: {
      files: [{ file: "/tmp/a.txt", patch: V2_EDIT_PATCH, status: "modified", additions: 3, deletions: 2 }],
      truncated: false,
    },
    ...overrides,
  };
}

describe("opencode v2 edit metadata", () => {
  it("renders the diff and exact stats from metadata.files[].patch", () => {
    const data = createToolCallData(v2EditItem());
    expect(data.presentation.diffStats).toEqual({ additions: 3, deletions: 2 });
    expect(data.detail).toEqual({
      type: "edit",
      filePath: "/tmp/a.txt",
      unifiedDiff:
        "@@ -1,4 +1,5 @@\n line one\n line 2 changed\n-line three\n-line four\n+line 3\n+line 4\n+line 5 added",
    });
  });

  it("prefers a unifiedDiff the daemon already put on the detail", () => {
    const data = createToolCallData(
      v2EditItem({ detail: { type: "edit", filePath: "/tmp/a.txt", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" } }),
    );
    expect(data.detail).toMatchObject({ unifiedDiff: "@@ -1 +1 @@\n-a\n+b" });
    expect(data.presentation.diffStats).toEqual({ additions: 1, deletions: 1 });
  });

  it("reads filediff.patch and diff metadata from earlier opencode shapes", () => {
    const filediff = createToolCallData(
      v2EditItem({ metadata: { filediff: { patch: "@@ -1 +1 @@\n-a\n+b" }, diff: "@@ -1 +1 @@\n-x\n+y" } }),
    );
    expect(filediff.detail).toMatchObject({ unifiedDiff: "@@ -1 +1 @@\n-a\n+b" });
    const diff = createToolCallData(v2EditItem({ metadata: { diff: "@@ -1 +1 @@\n-x\n+y" } }));
    expect(diff.detail).toMatchObject({ unifiedDiff: "@@ -1 +1 @@\n-x\n+y" });
  });

  it("keeps the old/new string fallback when metadata has no patch", () => {
    const data = createToolCallData(
      v2EditItem({
        detail: { type: "edit", filePath: "/tmp/a.txt", oldString: "a\n", newString: "b\n" },
        metadata: { truncated: false },
      }),
    );
    expect(data.detail).toEqual({ type: "edit", filePath: "/tmp/a.txt", oldString: "a\n", newString: "b\n" });
    expect(data.presentation.diffStats).toEqual({ additions: 1, deletions: 1 });
  });

  it("still omits stats for payload-less edits", () => {
    const data = createToolCallData(v2EditItem({ metadata: undefined }));
    expect(data.detail).toEqual({ type: "edit", filePath: "/tmp/a.txt" });
    expect(data.presentation.diffStats).toBeUndefined();
  });

  it("ignores another file's patch and patches without hunks", () => {
    const other = createToolCallData(
      v2EditItem({
        metadata: {
          files: [
            { file: "/tmp/x.txt", patch: "@@ -1 +1 @@\n-a\n+b" },
            { file: "/tmp/y.txt", patch: "@@ -1 +1 @@\n-c\n+d" },
          ],
        },
      }),
    );
    expect(other.presentation.diffStats).toBeUndefined();
    const noHunks = createToolCallData(v2EditItem({ metadata: { files: [{ file: "/tmp/a.txt", patch: "Index: x\n" }] } }));
    expect(noHunks.presentation.diffStats).toBeUndefined();
  });

  it("drops no-newline markers from the patch body", () => {
    const data = createToolCallData(
      v2EditItem({ metadata: { files: [{ file: "/tmp/a.txt", patch: "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n" }] } }),
    );
    expect(data.detail).toMatchObject({ unifiedDiff: "@@ -1 +1 @@\n-a\n+b" });
  });
});

describe("Pi read normalization", () => {
  it.each(["running", "completed"] as const)("recovers %s reads in timeline data", (status) => {
    const data = createToolCallData({
      type: "tool_call",
      callId: "read-image",
      name: "read",
      status,
      error: null,
      detail: {
        type: "unknown",
        input: { path: "/tmp/screenshot.png", offset: null, limit: null },
        output: status === "completed" ? {
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "base64-image-data", mimeType: "image/png" },
          ],
        } : undefined,
      },
    });

    expect(data.detail).toEqual({
      type: "read",
      filePath: "/tmp/screenshot.png",
      ...(status === "completed" ? { content: "Read image file [image/png]" } : {}),
    });
    expect(data.presentation).toMatchObject({ category: "file", label: "Read", filePath: "/tmp/screenshot.png" });
  });
});

describe("row expansion", () => {
  it("always expands regardless of latest state", () => {
    expect(resolveExpansion("always", true, null)).toBe(true);
    expect(resolveExpansion("always", false, null)).toBe(true);
  });

  it("expands latest rows only while they are the newest", () => {
    expect(resolveExpansion("latest", true, null)).toBe(true);
    expect(resolveExpansion("latest", false, null)).toBe(false);
  });

  it("never expands, even for the newest row", () => {
    expect(resolveExpansion("never", true, null)).toBe(false);
    expect(resolveExpansion("never", false, null)).toBe(false);
  });

  it("lets an explicit user toggle win over every mode", () => {
    expect(resolveExpansion("always", true, false)).toBe(false);
    expect(resolveExpansion("never", false, true)).toBe(true);
    expect(resolveExpansion("latest", false, true)).toBe(true);
    expect(resolveExpansion("latest", true, false)).toBe(false);
  });
});

describe("task update expansion", () => {
  it("recognizes the newest task update by timestamp", () => {
    expect(isLatestTaskUpdate(200, 200)).toBe(true);
    expect(isLatestTaskUpdate(100, 200)).toBe(false);
    expect(isLatestTaskUpdate(100, 0)).toBe(false);
  });

  it("collapses earlier task cards when another task update follows", () => {
    expect(resolveTaskUpdateExpansion("latest", false, 200, null)).toBe(false);
  });

  it("preserves the configured expansion mode", () => {
    expect(resolveTaskUpdateExpansion("always", false, 200, null)).toBe(true);
    expect(resolveTaskUpdateExpansion("latest", true, 200, null)).toBe(true);
    expect(resolveTaskUpdateExpansion("never", true, 200, null)).toBe(false);
  });

  it("expires a manual toggle in Latest mode when another task update arrives", () => {
    const override = { expanded: true, latestTimestamp: 200 };
    expect(resolveTaskUpdateExpansion("latest", true, 200, { expanded: false, latestTimestamp: 200 })).toBe(
      false,
    );
    expect(resolveTaskUpdateExpansion("latest", false, 200, override)).toBe(true);
    expect(resolveTaskUpdateExpansion("latest", false, 300, override)).toBe(false);
  });

  it("preserves manual toggles in Always and Never modes across task updates", () => {
    expect(
      resolveTaskUpdateExpansion("always", false, 300, { expanded: false, latestTimestamp: 200 }),
    ).toBe(false);
    expect(
      resolveTaskUpdateExpansion("never", false, 300, { expanded: true, latestTimestamp: 200 }),
    ).toBe(true);
  });
});

describe("todo data", () => {
  it("projects task items with ids and statuses", () => {
    expect(
      createTodoData({
        type: "todo",
        items: [
          { id: "a", text: "Write code", completed: true, status: "completed" },
          { text: "Run tests", completed: false, status: "in_progress" },
          { text: "Ship it", completed: false },
        ],
      }),
    ).toEqual({
      items: [
        { id: "a", title: "Write code", status: "completed" },
        { id: "todo-1", title: "Run tests", status: "in_progress" },
        { id: "todo-2", title: "Ship it", status: "pending" },
      ],
    });
  });

  it("returns null for an empty checklist", () => {
    expect(createTodoData({ type: "todo", items: [] })).toBeNull();
  });
});

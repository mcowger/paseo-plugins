import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { transformReasoning, transformTodo, transformToolCall } from "./transform";

function toolCall(detail: ToolCallDetail, status: "running" | "completed" = "completed") {
  return {
    type: "tool_call" as const,
    callId: "call-1",
    name: "edit",
    detail,
    status,
    error: null,
  };
}

describe("colorful activity timeline transforms", () => {
  it.each([
    ["wait", "Wait for Agent"],
    ["result", "Check Agent Result"],
  ])("identifies translated live %s calls from operation progress", (operation, label) => {
    const log = `Agent: f4815d0d77b2\nOperation: ${operation}\nType: reviewer | Status: running\nDescription: Review changes`;
    const result = transformToolCall({
      phase: "streaming",
      item: { ...toolCall({ type: "sub_agent", log }, "running"), name: "get_subagent_result" },
    });
    expect(result?.items[0]?.data).toMatchObject({
      status: "running", detail: { type: "sub_agent", log },
      presentation: { label, summary: "reviewer · Review changes · running" },
    });
  });

  it("replaces reasoning while preserving the streaming phase", () => {
    expect(
      transformReasoning({
        item: { type: "reasoning", text: "**Plan****Result**" },
        phase: "streaming",
      }),
    ).toEqual({
      items: [
        {
          type: "plugin",
          kind: "colorful-reasoning",
          version: 1,
          data: { text: "**Plan**\n\n**Result**", phase: "streaming" },
        },
      ],
    });
  });

  it("projects edit presentation, file icon, and diff stats", () => {
    const result = transformToolCall({
      phase: "complete",
      item: toolCall({
        type: "edit",
        filePath: "src/web/main.tsx",
        oldString: "const oldValue = 1;\n",
        newString: "const newValue = 2;\n",
      }),
    });
    expect(result).toEqual({
      items: [
        {
          type: "plugin",
          kind: "colorful-tool-call",
          version: 1,
          data: {
            name: "edit",
            status: "completed",
            detail: {
              type: "edit",
              filePath: "src/web/main.tsx",
              oldString: "const oldValue = 1;\n",
              newString: "const newValue = 2;\n",
            },
            presentation: {
              category: "file",
              icon: "FileCode2",
              label: "Edit",
              summary: "src/web/main.tsx",
              filePath: "src/web/main.tsx",
              fileIcon: "FileCode2",
              language: "typescript",
              diffStats: { additions: 1, deletions: 1 },
            },
          },
        },
      ],
    });
  });

  it("omits diff stats for file-only edits without a diff payload", () => {
    const result = transformToolCall({
      phase: "complete",
      item: toolCall({ type: "edit", filePath: "src/web/main.tsx" }),
    });
    expect(result?.items[0]?.data).toEqual({
      name: "edit",
      status: "completed",
      detail: { type: "edit", filePath: "src/web/main.tsx" },
      presentation: {
        category: "file",
        icon: "FileCode2",
        label: "Edit",
        summary: "src/web/main.tsx",
        filePath: "src/web/main.tsx",
        fileIcon: "FileCode2",
        language: "typescript",
      },
    });
  });

  it("projects running shell calls with a stable generic fallback", () => {
    const result = transformToolCall({
      phase: "streaming",
      item: {
        ...toolCall(
          { type: "shell", command: "bun test", output: "170 pass" },
          "running",
        ),
        name: "run",
      },
    });
    expect(result?.items[0]?.data).toMatchObject({
      name: "run",
      status: "running",
      presentation: {
        category: "shell",
        icon: "SquareTerminal",
        label: "Shell",
        summary: "bun test",
      },
    });
  });

  it("projects Pi bash structured envelopes into shell details", () => {
    const result = transformToolCall({
      phase: "complete",
      item: {
        ...toolCall({
          type: "unknown",
          input: { command: "bun test" },
          output: {
            content: [{ type: "text", text: "short" }],
            structuredContent: {
              output: "170 pass",
              truncated: true,
              exit_code: 0,
              full_output_path: "/tmp/out.txt",
            },
          },
        }),
        name: "bash",
      },
    });
    expect(result?.items[0]?.data).toMatchObject({
      name: "bash",
      status: "completed",
      detail: {
        type: "shell",
        command: "bun test",
        output: "170 pass",
        exitCode: 0,
        truncated: true,
        fullOutputPath: "/tmp/out.txt",
      },
      presentation: {
        category: "shell",
        icon: "SquareTerminal",
        label: "Shell",
        summary: "bun test",
      },
    });
  });

  it("emits one edit timeline item per apply_patch file", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/index.ts",
      "@@",
      "-old()",
      "+new()",
      "*** Add File: docs/notes.md",
      "+Notes",
      "*** End Patch",
    ].join("\n");
    const result = transformToolCall({
      phase: "complete",
      item: {
        ...toolCall({ type: "unknown", input: { input: patch }, output: null }),
        name: "apply_patch",
      },
    });

    expect(result?.items).toHaveLength(2);
    expect(result?.items.map((item) => item.id)).toEqual([
      "call-1:apply-patch:0",
      "call-1:apply-patch:1",
    ]);
    expect(result?.items.map((item) => item.data)).toEqual([
      expect.objectContaining({
        name: "apply_patch",
        detail: { type: "edit", filePath: "src/index.ts", unifiedDiff: "@@\n-old()\n+new()" },
        presentation: expect.objectContaining({ label: "Edit", diffStats: { additions: 1, deletions: 1 } }),
      }),
      expect.objectContaining({
        name: "apply_patch",
        detail: { type: "edit", filePath: "docs/notes.md", unifiedDiff: "+Notes" },
        presentation: expect.objectContaining({ label: "Add", diffStats: { additions: 1, deletions: 0 } }),
      }),
    ]);
  });

  it("splits OpenCode patch tool calls into one row per file", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: ocr/docs/plan.md",
      "+# Plan",
      "+Body",
      "*** Update File: src/index.ts",
      "@@",
      "-old()",
      "+new()",
      "*** Delete File: src/obsolete.ts",
      "*** End Patch",
    ].join("\n");
    const result = transformToolCall({
      phase: "complete",
      item: {
        ...toolCall(
          {
            type: "unknown",
            input: { patchText: patch },
            output: "Success. Updated the following files:\nA ocr/docs/plan.md\nM src/index.ts\nD src/obsolete.ts",
          },
        ),
        name: "patch",
      },
    });

    expect(result?.items.map((item) => item.id)).toEqual([
      "call-1:apply-patch:0",
      "call-1:apply-patch:1",
      "call-1:apply-patch:2",
    ]);
    expect(result?.items.map((item) => item.data)).toEqual([
      expect.objectContaining({ presentation: expect.objectContaining({ label: "Add", summary: "ocr/docs/plan.md" }) }),
      expect.objectContaining({ presentation: expect.objectContaining({ label: "Edit", summary: "src/index.ts" }) }),
      expect.objectContaining({ presentation: expect.objectContaining({ label: "Delete", summary: "src/obsolete.ts" }) }),
    ]);
  });

  it("prefers OpenCode patch metadata diffs over the raw patch text", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/index.ts",
      "@@",
      "-stale()",
      "+stale()",
      "*** End Patch",
    ].join("\n");
    const result = transformToolCall({
      phase: "complete",
      item: {
        ...toolCall({ type: "unknown", input: { patchText: patch }, output: null }),
        name: "patch",
        metadata: {
          files: [{ file: "src/index.ts", patch: "@@\n-old()\n+new()", additions: 1, deletions: 1, status: "modified" }],
        },
      },
    });

    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.data).toEqual(
      expect.objectContaining({
        detail: { type: "edit", filePath: "src/index.ts", unifiedDiff: "@@\n-old()\n+new()" },
        presentation: expect.objectContaining({ label: "Edit", diffStats: { additions: 1, deletions: 1 } }),
      }),
    );
  });

  it("keeps generic rendering for a patch tool without a parseable payload", () => {
    const result = transformToolCall({
      phase: "complete",
      item: {
        ...toolCall({ type: "unknown", input: { patchText: "not a patch" }, output: null }),
        name: "patch",
      },
    });

    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.data).toEqual(
      expect.objectContaining({ presentation: expect.objectContaining({ label: "Patch" }) }),
    );
  });

  it("preserves native speak tool calls with text input", () => {
    const result = transformToolCall({
      phase: "complete",
      item: {
        type: "tool_call",
        callId: "speak-1",
        name: "speak",
        detail: { type: "unknown", input: "Hello, I am ready.", output: null },
        status: "completed",
        error: null,
      },
    });
    expect(result).toBeUndefined();
  });

  it("suppresses the standalone todo checklist", () => {
    expect(
      transformTodo({
        phase: "complete",
        item: {
          type: "todo",
          items: [
            { id: "a", text: "Write code", completed: true },
            { text: "Run tests", completed: false, status: "in_progress" },
          ],
        },
      }),
    ).toEqual({ items: [] });
  });
});

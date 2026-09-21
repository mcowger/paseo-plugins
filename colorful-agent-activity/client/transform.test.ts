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
              label: "Edit File",
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
        presentation: expect.objectContaining({ label: "Edit File", diffStats: { additions: 1, deletions: 1 } }),
      }),
      expect.objectContaining({
        name: "apply_patch",
        detail: { type: "edit", filePath: "docs/notes.md", unifiedDiff: "+Notes" },
        presentation: expect.objectContaining({ label: "Add File", diffStats: { additions: 1, deletions: 0 } }),
      }),
    ]);
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

  it("projects todo checklists", () => {
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
    ).toEqual({
      items: [
        {
          type: "plugin",
          kind: "colorful-todo",
          version: 1,
          data: {
            items: [
              { id: "a", title: "Write code", status: "completed" },
              { id: "todo-1", title: "Run tests", status: "in_progress" },
            ],
          },
        },
      ],
    });
  });

  it("leaves empty todo checklists to the host", () => {
    expect(transformTodo({ phase: "complete", item: { type: "todo", items: [] } })).toBeUndefined();
  });
});

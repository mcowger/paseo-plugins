import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { transformReasoning, transformToolCall } from "./transform";

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
        label: "Shell Command",
        summary: "bun test",
      },
    });
  });
});

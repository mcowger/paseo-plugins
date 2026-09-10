import { describe, expect, it } from "vitest";

import type { PiSessionManagerLike } from "../shared/pi-sdk-types.js";
import { createPiTodoTool, hasPiTodoExtensionTool } from "./pi-todo-tool.js";

function makeManager(entries: unknown[]): PiSessionManagerLike {
  return {
    getEntries: () => entries,
    getBranch: () => entries,
    getLeafId: () => null,
    getEntry: () => null,
    branch: () => undefined,
    resetLeaf: () => undefined,
    appendCustomEntry: () => "entry",
  };
}

function appendToolResult(entries: unknown[], details: unknown): void {
  entries.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      details,
    },
  });
}

describe("hasPiTodoExtensionTool", () => {
  it("detects an extension-provided todo tool", () => {
    expect(
      hasPiTodoExtensionTool({ extensions: [{ tools: new Map([["todo", {}]]) }] }),
    ).toBe(true);
    expect(hasPiTodoExtensionTool({ extensions: [{ tools: new Map([["other", {}]]) }] })).toBe(
      false,
    );
  });
});

describe("createPiTodoTool", () => {
  it("supports branch-aware add, toggle, list, and clear actions", async () => {
    const entries: unknown[] = [];
    const tool = createPiTodoTool(makeManager(entries));

    const added = await tool.execute("todo-1", { action: "add", text: "Write tests" });
    expect(added.details).toMatchObject({
      action: "add",
      todos: [{ id: 1, text: "Write tests", done: false }],
      nextId: 2,
    });
    appendToolResult(entries, added.details);

    const toggled = await tool.execute("todo-2", { action: "toggle", id: 1 });
    expect(toggled.details).toMatchObject({
      action: "toggle",
      todos: [{ id: 1, text: "Write tests", done: true }],
      nextId: 2,
    });
    appendToolResult(entries, toggled.details);

    const listed = await tool.execute("todo-3", { action: "list" });
    expect(listed.content[0]?.text).toBe("[x] #1: Write tests");
    appendToolResult(entries, listed.details);

    const cleared = await tool.execute("todo-4", { action: "clear" });
    expect(cleared.details).toMatchObject({ action: "clear", todos: [], nextId: 1 });
    appendToolResult(entries, cleared.details);

    await expect(tool.execute("todo-5", { action: "list" })).resolves.toMatchObject({
      content: [{ text: "No todos" }],
      details: { action: "list", todos: [], nextId: 1 },
    });
  });

  it("serializes concurrent mutations", async () => {
    const tool = createPiTodoTool(makeManager([]));

    const [first, second] = await Promise.all([
      tool.execute("todo-1", { action: "add", text: "First" }),
      tool.execute("todo-2", { action: "add", text: "Second" }),
    ]);

    expect(first.details).toMatchObject({ todos: [{ id: 1, text: "First" }] });
    expect(second.details).toMatchObject({
      todos: [
        { id: 1, text: "First" },
        { id: 2, text: "Second" },
      ],
    });
  });

  it("reconstructs the current branch before executing an action", async () => {
    const entries: unknown[] = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: {
            action: "add",
            todos: [{ id: 4, text: "Existing", done: false }],
            nextId: 5,
          },
        },
      },
    ];
    const tool = createPiTodoTool(makeManager(entries));

    await expect(tool.execute("todo-1", { action: "add", text: "Next" })).resolves.toMatchObject({
      details: {
        todos: [
          { id: 4, text: "Existing", done: false },
          { id: 5, text: "Next", done: false },
        ],
        nextId: 6,
      },
    });
  });
});

import { describe, expect, it } from "vitest";

import { parseToolArgs } from "./tool-call-mapper.js";
import { extractTodoSnapshot } from "./todo.js";

function todoToolCall() {
  return parseToolArgs("todo", { action: "list" });
}

describe("extractTodoSnapshot", () => {
  it("parses the rpiv-todo tasks shape", () => {
    const todos = extractTodoSnapshot(todoToolCall(), {
      details: {
        tasks: [
          { id: 1, subject: "Write plan", status: "completed" },
          { id: 2, subject: "Implement", status: "in_progress", activeForm: "Implementing" },
          { id: 3, subject: "Test", status: "pending" },
          { id: 4, subject: "Dropped", status: "deleted" },
        ],
      },
    });
    expect(todos).toEqual([
      { id: "1", text: "Write plan", status: "completed" },
      { id: "2", text: "Implement", status: "in_progress", activeForm: "Implementing" },
      { id: "3", text: "Test", status: "pending" },
    ]);
  });

  it("parses the pi example todos shape", () => {
    const todos = extractTodoSnapshot(todoToolCall(), {
      details: {
        todos: [
          { id: 1, text: "First", done: true },
          { id: 2, text: "Second", done: false },
        ],
      },
    });
    expect(todos).toEqual([
      { id: "1", text: "First", status: "completed" },
      { id: "2", text: "Second", status: "pending" },
    ]);
  });

  it("returns null for non-todo tools", () => {
    expect(
      extractTodoSnapshot(parseToolArgs("bash", { command: "ls" }), {
        details: { tasks: [{ subject: "x", status: "pending" }] },
      }),
    ).toBeNull();
  });

  it("returns null for string results", () => {
    expect(extractTodoSnapshot(todoToolCall(), "done")).toBeNull();
  });

  it("returns null for unrecognized shapes", () => {
    expect(extractTodoSnapshot(todoToolCall(), { details: { tasks: "nope" } })).toBeNull();
  });
});

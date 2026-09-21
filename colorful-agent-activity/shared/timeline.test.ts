import { describe, expect, it } from "vitest";
import { createTodoData, resolveExpansion } from "./timeline";

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

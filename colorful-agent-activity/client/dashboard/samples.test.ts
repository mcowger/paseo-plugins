import { describe, expect, it } from "vitest";
import { reasoningItemDataSchema, todoItemDataSchema, toolCallItemDataSchema } from "../../shared/timeline";
import {
  SAMPLE_CODE,
  SAMPLE_EDIT,
  SAMPLE_READ,
  SAMPLE_REASONING,
  SAMPLE_SEARCH,
  SAMPLE_SHELL,
  SAMPLE_TODO,
  SAMPLE_TOOLS,
} from "./samples";

describe("dashboard preview samples", () => {
  it("produces data every previewed renderer accepts", () => {
    expect(reasoningItemDataSchema.safeParse(SAMPLE_REASONING).success).toBe(true);
    expect(todoItemDataSchema.safeParse(SAMPLE_TODO).success).toBe(true);
    for (const tool of SAMPLE_TOOLS) {
      expect(toolCallItemDataSchema.safeParse(tool).success).toBe(true);
    }
  });

  it("goes through the real transforms, so labels and categories match the timeline", () => {
    expect(SAMPLE_SHELL.presentation.category).toBe("shell");
    expect(SAMPLE_SHELL.presentation.label).toBe("Shell");
    expect(SAMPLE_SHELL.presentation.summary).toContain("npm run lint");
    expect(SAMPLE_EDIT.presentation.category).toBe("file");
    expect(SAMPLE_EDIT.presentation.diffStats).toEqual({ additions: 1, deletions: 1 });
    expect(SAMPLE_SEARCH.presentation.category).toBe("search");
    expect(SAMPLE_READ.presentation.fileIcon).toBeTruthy();
  });

  it("covers the surfaces the dashboard pages talk about", () => {
    const kinds = SAMPLE_TOOLS.map(
      (tool) => (tool.detail as unknown as { type?: string } | null)?.type,
    );
    expect(kinds).toEqual(["shell", "edit", "search", "read"]);
    expect(SAMPLE_TODO?.items).toHaveLength(3);
    expect(SAMPLE_TODO?.items.filter((item) => item.status === "completed")).toHaveLength(2);
    expect(SAMPLE_CODE.split("\n").length).toBeGreaterThan(2);
  });

  it("keeps the shell sample a useful failure story for exit codes", () => {
    const detail = SAMPLE_SHELL.detail as { exitCode?: number; output?: string } | null;
    expect(detail?.exitCode).toBe(1);
    expect(detail?.output).toContain("no-unused-vars");
  });
});

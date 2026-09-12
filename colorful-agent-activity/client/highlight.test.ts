import { describe, expect, it } from "vitest";
import { highlightCode, MAX_HIGHLIGHT_CHARS } from "./highlight";

describe("Syntax highlighting", () => {
  it("tokenizes shell commands without HTML or DOM APIs", async () => {
    const tokens = await highlightCode("$ bun run test\n170 pass", "bash", true);
    const content = tokens?.flat().map((token) => token.content).join("");
    expect(content).toContain("bun");
    expect(content).toContain("170 pass");
    expect(tokens?.flat().some((token) => token.color)).toBe(true);
  });

  it("tokenizes arbitrary JSON payloads", async () => {
    const tokens = await highlightCode(
      '{\n  "content": [{"type": "text"}]\n}',
      "json",
      true,
    );
    const content = tokens?.flat().map((token) => token.content).join("");
    expect(content).toContain('"content"');
    expect(content).toContain('"text"');
    expect(tokens?.flat().some((token) => token.color)).toBe(true);
  });

  it("tokenizes ANSI terminal output with color sequences", async () => {
    const tokens = await highlightCode("Normal \u001b[32mPASS\u001b[0m \u001b[38;2;255;0;0mFAIL\u001b[0m", "ansi", true);
    const content = tokens?.flat().map((token) => token.content).join("");
    expect(content).toBe("Normal PASS FAIL");
    expect(tokens?.flat().some((token) => token.color)).toBe(true);
    expect(tokens?.flat().find((token) => token.content === "FAIL")?.color).toBe("rgb(255,0,0)");
  });

  it("returns a fallback signal for oversized output", async () => {
    await expect(highlightCode("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ansi", true)).resolves.toBeNull();
  });
});

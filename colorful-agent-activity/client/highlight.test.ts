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

  it("maps syntax tokens to custom theme colors", async () => {
    const themeColors = {
      foreground: "#ffffff",
      foregroundMuted: "#888888",
      accent: "#00aaff",
      statusSuccess: "#00ff88",
      statusWarning: "#ffaa00",
      statusDanger: "#ff4444",
    };
    const code = 'const count = 42; // comment\nconst name = "hello";';
    const tokens = (await highlightCode(code, "javascript", themeColors))?.flat();
    expect(tokens).toBeDefined();

    const commentToken = tokens?.find((t) => t.content === "// comment");
    expect(commentToken?.color).toBe(themeColors.foregroundMuted);

    const stringToken = tokens?.find((t) => t.content === '"hello"');
    expect(stringToken?.color).toBe(themeColors.statusSuccess);

    const keywordToken = tokens?.find((t) => t.content === "const");
    expect(keywordToken?.color).toBe(themeColors.accent);

    const numberToken = tokens?.find((t) => t.content === "42");
    expect(numberToken?.color).toBe(themeColors.statusWarning);
  });

  it("colors bash strings, comments, variables, and keywords with the lightweight grammar", async () => {
    const themeColors = {
      foreground: "#ffffff",
      foregroundMuted: "#888888",
      accent: "#00aaff",
      statusSuccess: "#00ff88",
      statusWarning: "#ffaa00",
      statusDanger: "#ff4444",
    };
    const code = 'if [ -f "$FILE" ]; then\n  echo "found" # check file\nfi';
    const tokens = (await highlightCode(code, "bash", themeColors))?.flat();
    expect(tokens).toBeDefined();

    const comment = tokens?.find((t) => t.content.includes("# check file"));
    expect(comment?.color).toBe(themeColors.foregroundMuted);

    const str = tokens?.find((t) => t.content === '"found"');
    expect(str?.color).toBe(themeColors.statusSuccess);

    const keyword = tokens?.find((t) => t.content === "if");
    expect(keyword?.color).toBe(themeColors.accent);
  });
});

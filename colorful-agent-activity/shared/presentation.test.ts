import { describe, expect, it } from "vitest";
import {
  diffLinesForDetail,
  diffStatsFromStrings,
  diffStatsFromUnifiedDiff,
  fileIconForPath,
  formatReasoningText,
  languageForFilePath,
  resolveActivityPalette,
  resolveToolCallPresentation,
} from "./presentation";

const colors = {
  surface0: "#101010",
  surface1: "#181818",
  surface2: "#242424",
  border: "#444444",
  foreground: "#f4f4f5",
  foregroundMuted: "#a1a1aa",
  accent: "#60a5fa",
  accentForeground: "#0f172a",
  statusSuccess: "#4ade80",
  statusWarning: "#fbbf24",
  statusDanger: "#f87171",
};

describe("colorful activity presentation", () => {
  it("maps file extensions to icons and Shiki languages", () => {
    expect(fileIconForPath("src/web/main.tsx")).toBe("FileCode2");
    expect(fileIconForPath("package.json")).toBe("FileJson");
    expect(fileIconForPath("README.md")).toBe("FileText");
    expect(fileIconForPath(".env")).toBe("FileKey2");
    expect(languageForFilePath("src/web/main.tsx")).toBe("typescript");
    expect(languageForFilePath("styles.css")).toBe("css");
  });

  it("counts unified diff additions and deletions without file headers", () => {
    expect(
      diffStatsFromUnifiedDiff("--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    ).toEqual({ additions: 1, deletions: 1 });
  });

  it("counts changes when an edit only has old and new strings", () => {
    expect(diffStatsFromStrings("one\ntwo\n", "one\nthree\n")).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("creates colored diff rows from old and new strings", () => {
    expect(
      diffLinesForDetail({
        type: "edit",
        filePath: "main.ts",
        oldString: "const oldValue = 1;\n",
        newString: "const newValue = 2;\n",
      }),
    ).toEqual([
      { kind: "remove", text: "const oldValue = 1;" },
      { kind: "add", text: "const newValue = 2;" },
    ]);
  });

  it("maps known tool details to screenshot-style presentation", () => {
    expect(
      resolveToolCallPresentation({
        name: "edit",
        detail: { type: "edit", filePath: "src/web/main.tsx", oldString: "", newString: "x" },
      }),
    ).toMatchObject({
      category: "file",
      icon: "FileCode2",
      label: "Edit File",
      summary: "src/web/main.tsx",
      language: "typescript",
      diffStats: { additions: 1, deletions: 0 },
    });
    expect(
      resolveToolCallPresentation({
        name: "bash",
        detail: { type: "shell", command: "bun run typecheck && bun test" },
      }),
    ).toEqual({
      category: "shell",
      icon: "SquareTerminal",
      label: "Shell Command",
      summary: "bun run typecheck && bun test",
    });
  });

  it("keeps reasoning formatting outside code spans", () => {
    expect(formatReasoningText("**Plan****Result**\n\n`**inline**`")).toBe(
      "**Plan**\n\n**Result**\n\n`**inline**`",
    );
  });

  it("derives palette colors from Paseo theme tokens", () => {
    const palette = resolveActivityPalette("high_contrast", colors);
    expect(palette.categoryColors.shell).toBe(colors.statusWarning);
    expect(palette.categoryColors.reasoning).toBe(colors.accent);
    expect(palette.statusColors.failed).toBe(colors.statusDanger);
    expect(palette.borderWidth).toBe(2);
  });
});

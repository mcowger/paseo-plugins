import { describe, expect, it } from "vitest";
import {
  diffLinesForDetail,
  diffStatsFromStrings,
  diffStatsFromUnifiedDiff,
  fileIconForPath,
  formatReasoningText,
  languageForFilePath,
  parseSubAgentActionLog,
  paseoToolCategory,
  paseoToolIcon,
  paseoToolLabel,
  paseoToolLeafName,
  paseoToolSummary,
  paseoToolResult,
  unwrapPaseoToolOutput,
  resolveActivityPalette,
  resolveSubAgentActionPresentation,
  resolveToolCallPresentation,
  formatJson,
  prettyJson,
  formatUnknownValue,
  extractCodeInput,
  previewText,
  MAX_DIFF_CHARS,
  MAX_FORMAT_CHARS,
  PASEO_TOOL_ICONS,
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
  it("maps file extensions to icons and highlight languages", () => {
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
    expect(diffStatsFromStrings("one\ntwo", "one\ntwo\n")).toEqual({
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

  it("maps sub-agent actions to readable inline progress rows", () => {
    expect(resolveSubAgentActionPresentation("read", "README.md")).toEqual({
      icon: "FileText",
      label: "Read File",
      summaryIcon: "FileText",
    });
    expect(resolveSubAgentActionPresentation("find_files")).toEqual({
      icon: "Search",
      label: "Find Files",
    });
    expect(resolveSubAgentActionPresentation("shell", "git status")).toEqual({
      icon: "SquareTerminal",
      label: "Shell Command",
    });
  });

  it("recovers Claude-style sub-agent actions from the provider log", () => {
    expect(parseSubAgentActionLog("[Read] README.md\n[Shell] git status\nnot an action")).toEqual([
      { index: 0, toolName: "Read", summary: "README.md" },
      { index: 1, toolName: "Shell", summary: "git status" },
    ]);
  });

  it("gives namespaced Paseo tools a specialized title, icon, and summary", () => {
    const input = {
      title: "Random Number Agent 3",
      provider: "pi/plexus/gpt-5.6-luna",
    };
    expect(paseoToolLabel("mcp__paseo__create_agent")).toBe("Create Agent");
    expect(paseoToolLabel("mcp_paseo_create_agent")).toBe("Create Agent");
    expect(paseoToolIcon("paseo.create_agent")).toBe("Bot");
    expect(paseoToolLeafName("paseo_create_agent")).toBe("create_agent");
    expect(paseoToolLeafName("mcp_paseo_create_agent")).toBe("create_agent");
    expect(paseoToolLeafName("mcp__paseo__future_tool")).toBeNull();
    expect(paseoToolCategory("paseo_remote.create_agent")).toBe("agent");
    expect(paseoToolSummary("mcp__paseo__create_agent", input)).toBe(
      "Random Number Agent 3 · pi/plexus/gpt-5.6-luna",
    );
    expect(paseoToolLabel("mcp__github__create_issue")).toBeNull();
    expect(
      resolveToolCallPresentation({
        name: "mcp_paseo_create_agent",
        detail: { type: "unknown", input, output: { agentId: "agt_123" } },
      }),
    ).toMatchObject({
      category: "agent",
      icon: "Bot",
      label: "Paseo Create Agent",
      summary: "Random Number Agent 3 · pi/plexus/gpt-5.6-luna",
    });
    expect(
      resolveToolCallPresentation({
        name: "mcp__github__search_repositories",
        detail: { type: "unknown", input: { query: "paseo" }, output: {} },
      }),
    ).toMatchObject({
      category: "search",
      icon: "BookMarked",
      label: "GitHub Repository Search",
      summary: "paseo",
    });
    expect(
      resolveToolCallPresentation({
        name: "mcp__paseo__create_agent",
        detail: { type: "unknown", input, output: { agentId: "agt_123" } },
      }),
    ).toMatchObject({
      category: "agent",
      icon: "Bot",
      label: "Paseo Create Agent",
      summary: "Random Number Agent 3 · pi/plexus/gpt-5.6-luna",
    });
  });

  it("unwraps MCP text envelopes with diagnostic prefixes", () => {
    const output = {
      content: [
        {
          type: "text",
          text: 'availableModes_count=0\\n\\n{"agentId":"agt_123","status":"running"}',
        },
      ],
    };
    expect(unwrapPaseoToolOutput(output)).toEqual({
      agentId: "agt_123",
      status: "running",
    });
    expect(paseoToolResult({ ok: true, result: { browserId: "tab-1" } })).toEqual({
      browserId: "tab-1",
    });
    expect(
      paseoToolResult({
        ok: false,
        error: { code: "browser_timeout", message: "Timed out" },
      }),
    ).toEqual({
      ok: false,
      error: { code: "browser_timeout", message: "Timed out" },
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
    expect(palette.categoryColors.reasoning).toBe(colors.foregroundMuted);
    expect(palette.statusColors.failed).toBe(colors.statusDanger);
    expect(palette.borderWidth).toBe(2);
  });

  it("uses valid Activity icon for get_agent_activity", () => {
    expect(PASEO_TOOL_ICONS.get_agent_activity).toBe("Activity");
    expect(paseoToolIcon("mcp_paseo_get_agent_activity")).toBe("Activity");
    expect(
      resolveToolCallPresentation({
        name: "mcp_paseo_get_agent_activity",
        detail: { type: "unknown", input: { agentId: "agt_1" }, output: {} },
      }).icon,
    ).toBe("Activity");
  });

  it("lexically formats JSON without losing precision or key order", () => {
    const raw = '{"id":9007199254740993,"b":1,"a":2}';
    const formatted = prettyJson(raw);
    expect(formatted).toBe('{\n  "id": 9007199254740993,\n  "b": 1,\n  "a": 2\n}');
    expect(formatted).toContain("9007199254740993");

    // formatUnknownValue uses prettyJson
    expect(formatUnknownValue(raw)).toBe(formatted);
    expect(formatUnknownValue({ num: 123 })).toContain("123");

    // Rejects invalid JSON cleanly
    expect(prettyJson("not json")).toBeNull();

    // Bails out on oversized input
    const oversized = '{"key": "' + "x".repeat(MAX_FORMAT_CHARS) + '"}';
    expect(formatJson(oversized).limited).toBe(true);
  });

  it("extracts literal JavaScript code from code tool inputs", () => {
    expect(extractCodeInput("exec", { code: "console.log('hi');" })).toEqual({
      code: "console.log('hi');",
      language: "javascript",
    });
    expect(extractCodeInput("mcp__plugin__mcpscript", JSON.stringify({ code: "const x = 1;" }))).toEqual({
      code: "const x = 1;",
      language: "javascript",
    });
    expect(extractCodeInput("evaluate_browser", { expression: "window.location.href" })).toEqual({
      code: "window.location.href",
      language: "javascript",
    });
    expect(extractCodeInput("read_file", { path: "foo.ts" })).toBeUndefined();
  });

  it("protects against oversized diff calculations", () => {
    const largeOld = "a\n".repeat(60_000);
    const largeNew = "b\n".repeat(60_000);
    expect(largeOld.length + largeNew.length).toBeGreaterThan(MAX_DIFF_CHARS);

    // Fast fallback without hanging LCS
    const stats = diffStatsFromStrings(largeOld, largeNew);
    expect(stats.additions).toBe(60_000);
    expect(stats.deletions).toBe(60_000);

    const diffLines = diffLinesForDetail({
      type: "edit",
      filePath: "large.txt",
      oldString: largeOld,
      newString: largeNew,
    });
    expect(diffLines.length).toBe(2);
    expect(diffLines[0]?.kind).toBe("remove");
    expect(diffLines[1]?.kind).toBe("add");

    // Timeline presentation skips diffStats when edit is oversized
    const pres = resolveToolCallPresentation({
      name: "edit",
      detail: {
        type: "edit",
        filePath: "large.txt",
        oldString: largeOld,
        newString: largeNew,
      },
    });
    expect(pres.diffStats).toBeUndefined();
  });

  it("enforces strict 20-line and 4,000-character preview budget with surrogate safety", () => {
    // Under limit
    expect(previewText("line 1\nline 2")).toEqual({
      text: "line 1\nline 2",
      truncated: false,
      totalLines: 2,
      totalChars: 13,
    });

    // Over line limit
    const thirtyLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const linePreview = previewText(thirtyLines);
    expect(linePreview.truncated).toBe(true);
    expect(linePreview.text.split("\n").length).toBe(20);
    expect(linePreview.totalLines).toBe(30);

    // Over character limit
    const longSingleLine = "x".repeat(5000);
    const charPreview = previewText(longSingleLine);
    expect(charPreview.truncated).toBe(true);
    expect(charPreview.text.length).toBeLessThanOrEqual(4000);

    // Surrogate pair safety
    const textWithEmoji = "a".repeat(3999) + "🐱" + "b";
    const emojiPreview = previewText(textWithEmoji);
    expect(emojiPreview.truncated).toBe(true);
    const lastChar = emojiPreview.text.charCodeAt(emojiPreview.text.length - 1);
    // Must not end on a high surrogate
    expect(lastChar >= 0xd800 && lastChar <= 0xdbff).toBe(false);
  });
});

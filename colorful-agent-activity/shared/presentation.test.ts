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
    expect(palette.categoryColors.reasoning).toBe(colors.accent);
    expect(palette.statusColors.failed).toBe(colors.statusDanger);
    expect(palette.borderWidth).toBe(2);
  });
});

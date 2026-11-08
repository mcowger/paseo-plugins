import { describe, expect, it } from "vitest";
import { PASEO_TOOL_ICONS, paseoToolLabel, resolveToolCallPresentation } from "./presentation";
import { failureText, lookFor, looks, PASEO_TOOL_ZH, rowLabel, rowMotion, statusLabel, statusLooks, VIVID_CATEGORY_HUES, washAlpha, zh } from "./vivid-model";
import { piSubagentPresentation } from "./pi-subagents";

const HAN = /[一-鿿]/;
// Words that stay as-is inside Chinese labels: product and protocol names.
const KEPT = /^(?:Paseo|Agent|Provider|GitHub|Actions|PR|Exa|MCP|token)$/;
const englishWords = (text: string) => (text.match(/[A-Za-z]{2,}/g) ?? []).filter((word) => !KEPT.test(word));

describe("category looks match the Agent observatory", () => {
  // agent-observatory/client/agent-digest.tsx laneLooks + stats-breakdown.tsx kindLooks (kit v3 hues).
  const observatory = {
    think: { icon: "Brain", hue: "violet" },
    read: { icon: "FileText", hue: "blue" },
    search: { icon: "Search", hue: "indigo" },
    edit: { icon: "FilePen", hue: "green" },
    shell: { icon: "SquareTerminal", hue: "orange" },
    web: { icon: "Globe", hue: "cyan" },
    agent: { icon: "Bot", hue: "fuchsia" },
    plan: { icon: "ListChecks", hue: "teal" },
    other: { icon: "Puzzle", hue: "gray" },
  } as const;

  it("uses the observatory hue and icon for every shared category", () => {
    for (const [key, look] of Object.entries(observatory)) {
      expect(looks[key as keyof typeof observatory]).toMatchObject(look);
    }
    expect(looks.list.hue).toBe("blue");
    expect(looks.write.hue).toBe("green");
    expect(statusLooks.waiting).toMatchObject({ hue: "amber", icon: "Hand" });
  });

  it("gives categories the observatory lacks hues it does not use for tools", () => {
    const taken = new Set<string>(Object.values(observatory).map((look) => look.hue));
    for (const key of ["mcp", "paseo", "skill"] as const) expect(taken.has(looks[key].hue)).toBe(false);
    expect(new Set([looks.mcp.hue, looks.paseo.hue, looks.skill.hue]).size).toBe(3);
  });

  it("classifies web search like the observatory (search detail with toolName web_search)", () => {
    const presentation = { category: "search", label: "Search", icon: "Search" };
    expect(lookFor("web_search", { type: "search", toolName: "web_search" }, presentation)).toBe("web");
    expect(lookFor("Grep", { type: "search", toolName: "grep" }, presentation)).toBe("search");
    expect(lookFor("WebFetch", { type: "fetch" }, presentation)).toBe("web");
    expect(lookFor("mcp__exa__web_search_exa", { type: "unknown" }, { category: "search", label: "Exa Web Search", icon: "Search" })).toBe("web");
    expect(lookFor("mcp__paseo__create_agent", { type: "unknown" }, { category: "agent", label: "Paseo Create Agent", icon: "Bot" })).toBe("paseo");
    expect(lookFor("mcp__bots__list_bots", { type: "unknown" }, { category: "unknown", label: "Bots List Bots", icon: "Wrench" })).toBe("mcp");
    expect(lookFor("mystery", null, { category: "unknown", label: "Mystery", icon: "Wrench" })).toBe("other");
  });
});

describe("Chinese labels", () => {
  it("names every Paseo tool in Chinese", () => {
    const leaves = Object.keys(PASEO_TOOL_ICONS);
    expect(leaves.length).toBeGreaterThanOrEqual(60);
    for (const leaf of leaves) {
      const label = paseoToolLabel(`mcp__paseo__${leaf}`);
      expect(label, leaf).toBeTruthy();
      expect(PASEO_TOOL_ZH[label!], `${leaf} → ${label}`).toBeTruthy();
      const shown = zh(`Paseo ${label}`);
      expect(shown).toMatch(HAN);
      expect(englishWords(shown), shown).toEqual([]);
    }
  });

  it("translates Paseo rows end to end, from tool name to header", () => {
    const presentation = resolveToolCallPresentation({
      name: "mcp__paseo__send_agent_prompt",
      detail: { type: "unknown", input: { agentId: "a1", prompt: "继续" }, output: null },
    });
    expect(zh(presentation.label)).toBe("Paseo · 给 Agent 发消息");
  });

  it("translates every built-in row and section label", () => {
    for (const label of ["Read", "List", "Edit", "Add", "Delete", "Write", "Shell", "Search", "Find", "Fetch URL", "Agent Task", "Thinking", "Skill",
      "Tasks", "Ask Question", "Speak", "Worktree Setup", "Tool", "Search Tools", "Code Mode", "Wait", "Wait for Background Work", "Supervisor Reply",
      "GitHub Code Search", "Exa Web Search", "Command", "Output", "Contents", "Written contents", "Before", "After", "Diff", "Result", "Error",
      "Input", "Image", "Setup log", "Activity log", "Query", "Matches", "Files", "Message"]) {
      const shown = zh(label);
      expect(shown, label).toMatch(HAN);
      expect(englishWords(shown), label).toEqual([]);
    }
    expect(zh("Wait for 3 Agents")).toBe("等待 3 个 Agent");
    for (const name of ["TodoWrite", "NotebookEdit", "BashOutput", "KillShell", "WebSearch", "ExitPlanMode"]) expect(zh(name), name).toMatch(HAN);
  });

  it("keeps raw tool names (data) untouched", () => {
    expect(zh("Bots List Bots")).toBe("Bots List Bots");
  });

  it("names every Pi sub-agent row in Chinese, status included (0.5.0)", () => {
    const result = "Agent: 44066ba2c296\nType: explore | Status: completed | Tool uses: 2 | 14 token\nDescription: inspect payloads\n\npong";
    const cases: Array<[string, unknown, string]> = [
      ["Agent", {}, "派出子 Agent"],
      ["steer_subagent", {}, "引导子 Agent"],
      ["get_subagent_result", { wait: true }, "等待 Agent"],
      ["get_subagent_result", { wait: false }, "查看子 Agent 结果"],
      ["get_subagent_result", {}, "子 Agent 结果"],
    ];
    for (const [name, input, shown] of cases) {
      const presentation = piSubagentPresentation(name, input, result);
      expect(zh(presentation.label), name).toBe(shown);
      expect(englishWords(zh(presentation.label)), name).toEqual([]);
      expect(presentation.summary, name).toBe("inspect payloads · 已完成");
    }
    expect(statusLabel("background")).toBe("后台运行");
    expect(statusLabel("queued")).toBe("排队中");
  });
});

describe("vivid palette categories (0.5.0)", () => {
  it("tints each category with the hue of its icon: sub-agents magenta, not green", () => {
    expect(VIVID_CATEGORY_HUES).toEqual({
      reasoning: looks.think.hue, shell: looks.shell.hue, file: looks.read.hue, search: looks.search.hue,
      agent: looks.agent.hue, plan: looks.plan.hue, communication: looks.mcp.hue, unknown: null,
    });
    expect(VIVID_CATEGORY_HUES.agent).toBe("fuchsia");
  });
});

describe("row motion", () => {
  it("mounts no motion for an idle finished row", () => {
    expect(Object.values(rowMotion({ status: "completed", statusChanges: 0, finishes: 0, live: false })).some(Boolean)).toBe(false);
    expect(Object.values(rowMotion({ status: "canceled", statusChanges: 0, finishes: 0, live: false })).some(Boolean)).toBe(false);
  });

  it("animates only what is happening", () => {
    expect(rowMotion({ status: "running", statusChanges: 0, finishes: 0, live: false })).toMatchObject({ spin: true, sweep: true, ping: false, pop: false });
    expect(rowMotion({ status: "waiting", statusChanges: 1, finishes: 0, live: false })).toMatchObject({ ping: true, pop: true, spin: false });
    expect(rowMotion({ status: "completed", statusChanges: 1, finishes: 1, live: false })).toMatchObject({ pop: true, flash: true, sweep: false });
    expect(rowMotion({ status: "completed", statusChanges: 0, finishes: 0, live: true }).breathe).toBe(true);
  });

  it("washes only live and attention rows, a little stronger on light themes than before", () => {
    expect(washAlpha("completed", true)).toBe(0);
    expect(washAlpha("canceled", false)).toBe(0);
    expect(washAlpha("running", true)).toBe(0.14);
    expect(washAlpha("failed", false)).toBe(0.1);
    expect(washAlpha("waiting", false)).toBeGreaterThan(0.08);
  });
});

describe("failed row words", () => {
  it("shows the exit code from the detail (Codex/ACP) or Claude's error text", () => {
    expect(failureText({ type: "shell", exitCode: 2 }, undefined)).toBe("退出码 2");
    expect(failureText({ type: "shell" }, "Exit code 1\n\n> demo@1.0.0 lint")).toBe("退出码 1");
    expect(failureText({ type: "shell", exitCode: 0 }, "Exit code 0")).toBeUndefined();
    expect(failureText({ type: "edit" }, "File not found")).toBeUndefined();
    expect(failureText(null, undefined)).toBeUndefined();
  });

  it("shows status values in Chinese, keeping unknown values as data", () => {
    expect(statusLabel("running")).toBe("运行中");
    expect(statusLabel("Active")).toBe("当前");
    expect(statusLabel("active")).toBe("启用中");
    expect(statusLabel("FAILED")).toBe("失败");
    expect(statusLabel("custom-state")).toBe("custom-state");
  });
});

describe("row label for screen readers", () => {
  it("names the action, the path as shown and attention states", () => {
    expect(rowLabel({ expanded: false, title: "编辑", fileDisplay: { dir: "src", base: "greet.ts" }, summary: "/abs/src/greet.ts", status: "completed" })).toBe("展开 编辑 src/greet.ts");
    expect(rowLabel({ expanded: true, title: "命令", summary: "npm run lint", status: "failed" })).toBe("收起 命令 npm run lint，失败");
    expect(rowLabel({ expanded: false, title: "命令", summary: "rm -rf dist", status: "waiting" })).toBe("展开 命令 rm -rf dist，等你批准");
    expect(rowLabel({ expanded: false, title: "思考" })).toBe("展开 思考");
  });
});

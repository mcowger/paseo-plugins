import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPiNotice, piNoticeState, piStatusWords, readPiNotice, unescapeXml, type PiNotice } from "./pi-notice";

type Row = {
  type: string;
  callId: string;
  name: string;
  status: string;
  detail: { type: string; text?: string };
  metadata: { synthetic: boolean; customType: string; details?: unknown };
  error: null;
};

// Built by the 0.11.1 host's own mapCustomMessageToToolCall from Pi custom messages written after each extension's formatter.
const fixtures = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/pi-notices-0.11.1.json"), "utf8"),
) as { rows: Array<{ name: string; row: Row }> };

const fixture = (name: string): Row => {
  const found = fixtures.rows.find((entry) => entry.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return structuredClone(found.row);
};
const read = (name: string): PiNotice => {
  const notice = readPiNotice(fixture(name));
  if (!notice) throw new Error(`fixture ${name} was not read`);
  return notice;
};
/** The same row without `metadata.details`: what an older extension (or one that sends none) gives. */
const textOnly = (name: string): PiNotice => {
  const row = fixture(name);
  delete row.metadata.details;
  return readPiNotice(row)!;
};
const withDetails = (name: string, details: unknown): PiNotice => {
  const row = fixture(name);
  row.metadata.details = details;
  return readPiNotice(row)!;
};
/** A row shaped like mapCustomMessageToToolCall's output. */
const row = (customType: string, text: string | undefined, details?: unknown): Row => ({
  type: "tool_call",
  callId: "pi-custom-x",
  name: customType,
  status: "completed",
  detail: text === undefined ? { type: "plain_text" } : { type: "plain_text", text },
  metadata: { synthetic: true, customType, ...(details === undefined ? {} : { details }) },
  error: null,
});
const notice = (customType: string, text: string | undefined, details?: unknown) => readPiNotice(row(customType, text, details))!;
const field = (value: PiNotice, label: string) => value.fields.find((entry) => entry.label === label)?.value;
const labels = (value: PiNotice) => value.fields.map((entry) => entry.label);
const everything = (value: PiNotice) => JSON.stringify(value);

describe("recognising Pi notice rows", () => {
  it("reads every 0.11.1 fixture row into a one-line Chinese card", () => {
    expect(fixtures.rows.length).toBeGreaterThan(20);
    for (const { name, row: item } of fixtures.rows) {
      const value = readPiNotice(item);
      expect(value, name).not.toBeNull();
      expect(value!.customType, name).toBe(item.metadata.customType);
      expect(value!.summary, name).toMatch(/\S/);
      expect(value!.summary, name).not.toMatch(/[\r\n]/);
      expect(new Set(labels(value!)).size, name).toBe(value!.fields.length);
      expect(["done", "failed", "stopped", "running", "info"], name).toContain(value!.state);
      expect(isPiNotice(item), name).toBe(true);
    }
  });

  it("leaves every other row alone, Claude Code's task notifications included", () => {
    const claude = {
      type: "tool_call",
      callId: "task_notification_x",
      name: "task_notification",
      status: "completed",
      detail: { type: "plain_text", label: 'Agent "审查" finished', icon: "wrench", text: "<task-notification>…</task-notification>" },
      metadata: { synthetic: true, source: "claude_task_notification", taskId: "a1", toolUseId: "toolu_1", status: "completed" },
      error: null,
    };
    const bash = { type: "tool_call", callId: "toolu_2", name: "Bash", status: "completed", detail: { type: "shell", command: "ls", output: "a" }, error: null };
    // OMP's advisor notes: Paseo labels these itself (omp/advisor-message.js).
    const advisor = { type: "tool_call", callId: "omp-advisor:1", name: "advisor", status: "completed", detail: { type: "plain_text", label: "1 note", text: "n", icon: "brain" }, metadata: { synthetic: true, source: "omp_advisor", noteCount: 1, blockerCount: 0 }, error: null };
    const plain = { name: "deploy-status", status: "completed", detail: { type: "plain_text", text: "x" } };
    const base = row("deploy-status", "x");
    for (const item of [
      claude,
      bash,
      advisor,
      plain,
      { ...base, name: "other-name" },
      { ...base, metadata: { ...base.metadata, synthetic: false } },
      { ...base, metadata: { synthetic: true } },
      { ...row("", "x") },
      { ...row("   ", "x") },
      { ...base, metadata: { synthetic: true, customType: 7 } },
      { ...base, detail: { type: "shell", command: "x" } },
      { ...base, detail: undefined },
    ]) {
      expect(readPiNotice(item as Row)).toBeNull();
      expect(isPiNotice(item)).toBe(false);
    }
  });

  it("never throws on malformed input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const exploding = { synthetic: true } as Record<string, unknown>;
    Object.defineProperty(exploding, "customType", { get: () => { throw new Error("boom"); }, enumerable: true });
    const junk: unknown[] = [null, undefined, 0, "x", [], {}, { name: 1 }, { name: "a", metadata: [] }, { name: "a", metadata: { synthetic: true, customType: "a" }, detail: "text" }, { name: "a", metadata: exploding, detail: { type: "plain_text" } }];
    for (const item of junk) {
      expect(() => readPiNotice(item as Row)).not.toThrow();
      expect(() => isPiNotice(item)).not.toThrow();
    }
    expect(readPiNotice({ name: "a", metadata: exploding, detail: { type: "plain_text" } })).toBeNull();
    // Unknown type, no text, details that cannot become JSON: still a card.
    expect(notice("deploy-status", undefined, circular)).toMatchObject({ title: "Pi 通知", summary: "deploy-status", state: "info" });
    // Every known type with nothing usable: a card, never an exception.
    const types = [
      "background-task-notification", "subagent-notify", "subagent-notification", "subagent-update", "subagent-workspace-notice",
      "subagent_supervisor_request", "subagent-supervisor-unanswered", "subagent-supervisor-blocked", "subagent_control_notice",
      "subagent_steering_notice", "subagent_watchdog_warning", "subagent_watchdog_clarification", "subagent-wait-subscription",
      "subagent-incremental-child-notify", "subagent-workflow-result-write-failed", "web-search-content-ready", "web-search-error",
      "web-search-results", "goal-contract", "goal-budget-wrap-up",
    ];
    for (const type of types) {
      for (const [text, details] of [["", undefined], [undefined, 42], ["garbage <x>", "str"], ["", [1, 2]], ["\n\n", { runs: "no", event: 5, others: {} }], [undefined, circular]] as const) {
        let value: PiNotice | null = null;
        expect(() => { value = readPiNotice(row(type, text, details)); }, type).not.toThrow();
        expect(value, type).not.toBeNull();
        expect(value!.summary, type).toMatch(/\S/);
      }
    }
  });

  it("falls back to a generic card that keeps the text when a known type's text is not the expected shape", () => {
    expect(notice("background-task-notification", "Task bookkeeping was rotated.")).toEqual({
      customType: "background-task-notification",
      look: "shell",
      title: "后台任务",
      summary: "Task bookkeeping was rotated.",
      state: "info",
      fields: [{ label: "类型", value: "background-task-notification", mono: true }],
    });
    expect(notice("subagent_control_notice", "Something new\nwith two lines")).toMatchObject({ look: "agent", title: "子 Agent", summary: "Something new", body: "Something new\nwith two lines", state: "info" });
    expect(notice("web-search-content-ready", "All pages cached.")).toMatchObject({ look: "web", summary: "All pages cached.", state: "info" });
  });

  it("keeps the whole text in the body when the header had to clip it", () => {
    const question = `Should I ${"really ".repeat(40)}drop the table?`;
    const value = notice("subagent_supervisor_request", "", { reason: "need_decision", agent: "migrator", requestBody: question });
    expect(value.summary.endsWith("…")).toBe(true);
    expect(value.body).toBe(question);
    const point = `Missed ${"constraint ".repeat(30)}here`;
    const warning = notice("subagent_watchdog_warning", "", { severity: "concern", summary: point, evidence: "e", recommendedAction: "a" });
    expect(field(warning, "要点")).toBe(point);
    expect(labels(notice("subagent_watchdog_warning", "", { severity: "concern", summary: "short", evidence: "e", recommendedAction: "a" }))).not.toContain("要点");
  });

  it("does not look parser names up on Object.prototype", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(notice(type, "hello")).toMatchObject({ customType: type, look: "other", title: "Pi 通知", summary: "hello", state: "info" });
    }
  });
});

describe("states and words", () => {
  it("maps only explicit status words; an unknown status is never done", () => {
    for (const status of ["completed", "complete", "success", "succeeded", "done", "Completed"]) expect(piNoticeState(status), status).toBe("done");
    for (const status of ["failed", "error"]) expect(piNoticeState(status), status).toBe("failed");
    for (const status of ["killed", "stopped", "cancelled", "canceled", "paused", "aborted"]) expect(piNoticeState(status), status).toBe("stopped");
    for (const status of ["running", "in_progress", "queued"]) expect(piNoticeState(status), status).toBe("running");
    for (const status of ["", "ok", "zombie", "wrapped", undefined, null, 5, {}]) expect(piNoticeState(status), String(status)).toBe("info");
  });

  it("says them in Chinese and keeps unknown ones as sent", () => {
    expect(piStatusWords("completed")).toBe("已完成");
    expect(piStatusWords("failed")).toBe("失败");
    expect(piStatusWords("killed")).toBe("已停止");
    expect(piStatusWords("paused")).toBe("已暂停");
    expect(piStatusWords("cancelled")).toBe("已取消");
    expect(piStatusWords("running")).toBe("运行中");
    expect(piStatusWords("zombie")).toBe("zombie");
  });

  it("unescapes XML with &amp; last", () => {
    expect(unescapeXml("a &amp;lt; b")).toBe("a &lt; b");
    expect(unescapeXml("&lt;x&gt; &amp; &quot;y&quot; &apos;z&#39;")).toBe("<x> & \"y\" 'z'");
  });
});

describe("background-task-notification (pi-background-tasks)", () => {
  it("draws a completed task from its details", () => {
    expect(read("bg-completed")).toEqual({
      customType: "background-task-notification",
      look: "shell",
      title: "后台任务",
      summary: "「构建」已完成（退出码 0）",
      state: "done",
      fields: [
        { label: "任务", value: "构建" },
        { label: "状态", value: "已完成" },
        { label: "退出码", value: "0" },
        { label: "命令", value: "npm run build", mono: true },
        { label: "输出文件", value: ".pi/tasks/session-a1-4242/b1f0c2d3e.output", mono: true },
        { label: "耗时", value: "1 分 5 秒" },
        { label: "任务 ID", value: "b1f0c2d3e", mono: true },
      ],
    });
    // The same from the XML alone; the guidance for the model is never shown.
    const text = textOnly("bg-completed");
    expect(text).toMatchObject({ summary: "「构建」已完成（退出码 0）", state: "done" });
    expect(field(text, "输出文件")).toBe(".pi/tasks/session-a1-4242/b1f0c2d3e.output");
    expect(everything(text)).not.toMatch(/bg_status|guidance|durable/);
  });

  it("shows a failure in red with its exit code and the name unescaped", () => {
    for (const value of [read("bg-failed"), textOnly("bg-failed")]) {
      expect(value).toMatchObject({ summary: "「lint & test <ci>」失败（退出码 1）", state: "failed" });
      expect(field(value, "错误")).toBe("Exited with code 1");
    }
    const literal = notice("background-task-notification", "<background-task-notification>\n  <task-name>a &amp;lt; b</task-name>\n  <status>completed</status>\n</background-task-notification>");
    expect(literal.summary).toBe("「a &lt; b」已完成");
  });

  it("treats killed as stopped and a literal null exit code as no exit code", () => {
    const killed = read("bg-killed");
    expect(killed).toMatchObject({ summary: "「dev server」已停止（信号 SIGTERM）", state: "stopped" });
    expect(field(killed, "错误")).toBe("Timed out after 600s");
    expect(labels(killed)).not.toContain("退出码");
    const text = textOnly("bg-killed");
    expect(fixture("bg-killed").detail.text).toContain("<exit-code>null</exit-code>");
    expect(text).toMatchObject({ summary: "「dev server」已停止", state: "stopped" });
    expect(labels(text)).not.toContain("退出码");
  });

  it("prefers details over the text, and falls back to the text when details have no known shape", () => {
    const details = fixture("bg-completed").metadata.details as Record<string, unknown>;
    expect(withDetails("bg-completed", { ...details, status: "failed", exitCode: 2 })).toMatchObject({ summary: "「构建」失败（退出码 2）", state: "failed" });
    expect(withDetails("bg-completed", "garbage")).toMatchObject({ summary: "「构建」已完成（退出码 0）", state: "done" });
    expect(withDetails("bg-completed", { foo: 1 })).toMatchObject({ summary: "「构建」已完成（退出码 0）", state: "done" });
    // No text at all: the details alone.
    expect(notice("background-task-notification", undefined, { name: "构建", status: "completed", exitCode: 0 })).toMatchObject({ summary: "「构建」已完成（退出码 0）", state: "done" });
  });

  it("never turns an unknown or missing status into done", () => {
    const xml = (status: string) => `<background-task-notification>\n  <task-name>构建</task-name>${status}\n</background-task-notification>`;
    expect(notice("background-task-notification", xml("\n  <status>running</status>"))).toMatchObject({ summary: "「构建」运行中", state: "running" });
    expect(notice("background-task-notification", xml("\n  <status>zombie</status>"))).toMatchObject({ summary: "「构建」状态：zombie", state: "info" });
    expect(notice("background-task-notification", xml(""))).toMatchObject({ summary: "「构建」", state: "info" });
  });
});

describe("subagent-notify (pi-subagents)", () => {
  it("shows a failed background run with its error, output and session, minus the instructions for the model", () => {
    for (const value of [read("notify-failed"), textOnly("notify-failed")]) {
      expect(value).toMatchObject({ look: "agent", title: "子 Agent", summary: "「reviewer」失败", state: "failed" });
      expect(field(value, "错误")).toBe("Model request failed: 429 Too Many Requests");
      expect(field(value, "会话文件")).toBe("/home/user/.pi/agent/sessions/--home-user-demo-app--/7c1e2f60/run-0/session.jsonl");
      expect(value.body).toBe("已检查 3 个文件，发现 1 处问题后中断：\n- src/auth/session.ts:42 过期判断写反了");
      expect(everything(value)).not.toMatch(/Parent action|Retention-managed|reviewer:/);
    }
    expect(field(read("notify-failed"), "耗时")).toBe("48 秒");
  });

  it("says paused and stopped runs in grey, with the foreground source and the schedule", () => {
    const paused = read("notify-paused-foreground");
    expect(paused).toMatchObject({ summary: "「planner」（2/3）已暂停", state: "stopped" });
    expect(field(paused, "来源")).toBe("前台运行转到后台");
    expect(textOnly("notify-paused-foreground")).toMatchObject({ summary: "「planner」（2/3）已暂停", state: "stopped" });
    const stopped = read("notify-stopped-scheduled");
    expect(stopped).toMatchObject({ summary: "「nightly-audit」已停止", state: "stopped" });
    expect(field(stopped, "定时任务")).toBe("夜间巡检（sch_42）");
    expect(stopped.body).toBeUndefined(); // (no output)
  });

  it("turns a workflow's child outputs into a Chinese list", () => {
    const value = read("notify-workflow-failed");
    expect(value).toMatchObject({ summary: "「workflow」失败", state: "failed" });
    expect(field(value, "工作流")).toBe("wf-0001");
    expect(value.body).toBe([
      "Workflow failed.",
      "",
      "子任务输出：",
      "• review · 已完成 · 运行 r-0001",
      "  保存的输出：.pi/out/review.md",
      "  审查完成：没有阻断问题。",
      "  建议补一条回归测试。",
      "• tests · 失败 · 运行 r-0002",
      "  错误：npm test exited with code 1",
      "  预览不可用（no safe inline output）",
    ].join("\n"));
    expect(field(textOnly("notify-workflow-failed"), "工作流")).toBe("wf-0001");
  });

  it("splits a grouped completion by its agents, not by numbered lists in the output", () => {
    for (const value of [read("notify-grouped"), textOnly("notify-grouped")]) {
      expect(value).toMatchObject({ summary: "2 个子 Agent 已完成：「scout」「reviewer」", state: "done" });
      expect(field(value, "各子 Agent")).toBe("scout：已完成\nreviewer：已完成");
      expect(value.body).toContain("「scout」已完成\n1. 读了 src/app.ts\n2. 读了 src/greet.ts\n结论：入口很简单。");
      expect(value.body).toContain("「reviewer」（2/2）已完成\n定时任务：每日审查（sch_7）\n没有发现问题。");
      expect(everything(value)).not.toMatch(/Parent action|Retention-managed/);
    }
    // A preview line that happens to read like the next section header is still preview.
    const tricky = notice(
      "subagent-notify",
      ["Background tasks completed (2): **scout**, **reviewer**", "", "1. scout", "1. listed files", "2. reviewer comments are next", "", "2. reviewer", "LGTM"].join("\n"),
    );
    expect(tricky.body).toBe("「scout」已完成\n1. listed files\n2. reviewer comments are next\n\n「reviewer」已完成\nLGTM");
    // Statuses from details win over the batch header.
    const details = fixture("notify-grouped").metadata.details as { runs: Array<Record<string, unknown>> };
    const mixed = withDetails("notify-grouped", { runs: [details.runs[0], { ...details.runs[1], status: "failed" }] });
    expect(mixed).toMatchObject({ summary: "2 个子 Agent 已结束：1 个已完成、1 个失败", state: "failed" });
  });

  it("reads the pre-0.77 text (details null), a saved-output pointer and an output that merely starts with Error:", () => {
    const text = [
      "Background task completed: **scout**", "", "scout:", "# Code Context", "", "## Files Retrieved", "src/app.ts", "",
      "Output saved to: /tmp/pi-subagents-uid-1000/outputs/0a1b/context.md (356 B, 13 lines). Read this file if needed.", "",
      "Retention-managed async directory: /tmp/pi-subagents-uid-1000/async-subagent-runs/0a1b", "",
      "Session file: /home/user/.pi/agent/sessions/x/0a1b/run-0/session.jsonl",
    ].join("\n");
    const value = notice("subagent-notify", text, null);
    expect(value).toMatchObject({ summary: "「scout」已完成", state: "done", body: "# Code Context\n\n## Files Retrieved\nsrc/app.ts" });
    expect(field(value, "输出文件")).toBe("/tmp/pi-subagents-uid-1000/outputs/0a1b/context.md");
    expect(field(value, "会话文件")).toBe("/home/user/.pi/agent/sessions/x/0a1b/run-0/session.jsonl");
    const errorish = notice("subagent-notify", "Background task completed: **lint**\n\nError: none found\n12 files clean");
    expect(errorish).toMatchObject({ state: "done", body: "Error: none found\n12 files clean" });
    expect(labels(errorish)).not.toContain("错误");
  });

  it("does not show a workflow whose children still run as done", () => {
    const value = notice("subagent-notify", "Background task completed: **workflow** (dispatch complete; 2 children running or uncollected)\n\nWorkflow dispatched.");
    expect(value).toMatchObject({ summary: "「workflow」已派发完，2 个子任务仍在运行或未收取", state: "info" });
  });

  it("lets details decide the status when header and details disagree", () => {
    expect(withDetails("notify-failed", { runs: [{ agent: "reviewer", status: "stopped" }] })).toMatchObject({ summary: "「reviewer」已停止", state: "stopped" });
  });
});

describe("subagent-notification (@tintinweb / @gotgenes pi-subagents)", () => {
  it("draws a single completion with its usage and result", () => {
    const value = read("tintinweb-single");
    expect(value).toMatchObject({ look: "agent", title: "子 Agent", summary: "「梳理登录流程」已完成", state: "done" });
    expect(field(value, "Token")).toBe("18642");
    expect(field(value, "工具调用次数")).toBe("4");
    expect(field(value, "轮数")).toBe("5/30");
    expect(field(value, "耗时")).toBe("53 秒");
    expect(field(value, "Agent ID")).toBe("3f9a1c2e-5b7d-4e8");
    expect(value.body).toBe("登录流程分三步：\n1. 表单提交到 /api/login\n2. 服务端校验后写 session\n3. 前端跳转首页");
    const gotgenes = read("gotgenes-single");
    expect(gotgenes).toMatchObject({ summary: "「list files」已完成", state: "done", body: "The workspace has 12 files; the entry point is src/app.ts." });
    expect(everything(gotgenes)).not.toMatch(/get_subagent_result/);
  });

  it("draws a group of completions with every outcome, from details or from the XML", () => {
    for (const value of [read("tintinweb-group"), textOnly("tintinweb-group")]) {
      expect(value).toMatchObject({ summary: "3 个子 Agent 已结束：2 个已完成、1 个失败", state: "failed" });
      expect(field(value, "各子 Agent")).toBe("检查依赖：已完成\n跑单元测试：失败\n检查文档：已完成");
      expect(value.body).toBe("「检查依赖」已完成\n依赖都是最新的。\n\n「跑单元测试」失败\n错误：Request timed out\n\n「检查文档」已完成\nREADME 缺少安装说明。");
    }
    const partial = fixture("tintinweb-group");
    partial.detail.text = partial.detail.text!.replace("3 agent(s) finished", "2 agent(s) finished (partial — others still running)");
    expect(readPiNotice(partial)!.summary).toMatch(/，其余仍在运行$/);
  });

  it("names each status honestly", () => {
    const one = (details: Record<string, unknown>) => notice("subagent-notification", "", { id: "x1", description: "审查", ...details });
    expect(one({ status: "error", error: "boom" })).toMatchObject({ summary: "「审查」失败", state: "failed" });
    expect(field(one({ status: "error", error: "boom" }), "错误")).toBe("boom");
    expect(one({ status: "aborted" })).toMatchObject({ summary: "「审查」已停止（超出轮数上限）", state: "stopped" });
    expect(one({ status: "steered" })).toMatchObject({ summary: "「审查」已完成（到了轮数上限，被引导收尾）", state: "done" });
    expect(one({ status: "stopped" })).toMatchObject({ summary: "「审查」已停止", state: "stopped" });
    expect(one({ status: "queued" })).toMatchObject({ summary: "「审查」排队中", state: "running" });
    expect(one({ status: "mystery" })).toMatchObject({ summary: "「审查」状态：mystery", state: "info" });
    const queued = notice("subagent-notification", '<task-notification>\n<task-id>q1</task-id>\n<status>Stopped before starting</status>\n<summary>Subagent "&quot;fix&quot; it" was stopped while queued and never started</summary>\n</task-notification>');
    expect(queued).toMatchObject({ summary: "「\"fix\" it」排队时被停止，没有运行", state: "stopped" });
  });

  it("shows a running sub-agent's update as information, not as a running row", () => {
    const value = read("gotgenes-update");
    expect(value).toMatchObject({ summary: "「migrate db」发来进展：Schema diff ready; 2 tables change.（仍在运行）", state: "info" });
    expect(value.body).toBe("Schema diff ready; 2 tables change.\nWaiting on the users table backfill.");
    expect(everything(value)).not.toMatch(/steer_subagent/);
    expect(notice("subagent-workspace-notice", "", { id: "w1", description: "重构", notice: "Changes kept on branch pi/refactor-1." })).toMatchObject({
      summary: "「重构」的隔离工作区已拆除，留下了改动：Changes kept on branch pi/refactor-1.",
      state: "info",
    });
  });
});

describe("notices to the parent agent: one line of information, never a to-do for you", () => {
  const modelOnly = /subagent_supervisor\(|subagent\(\{|Reply with|Live guidance|Hint:|Inspect the run status|blocker_guidance|weigh, don't/;

  it("supervisor requests", () => {
    const value = read("supervisor-request");
    expect(value).toMatchObject({ look: "agent", title: "子 Agent 请求", state: "info", summary: "「migrator」请父 Agent 做决定：要不要把旧的 users 表直接删掉？还是先保留一个版本做回滚？" });
    expect(field(value, "请求 ID")).toBe("req-0001");
    expect(everything(value)).not.toMatch(modelOnly);
    expect(textOnly("supervisor-request")).toMatchObject({ summary: value.summary, state: "info" });
    const progress = notice("subagent_supervisor_request", "Subagent progress update.\nRun: r1\nAgent: scout\nChild index: 0\n\n读完了一半。");
    expect(progress.summary).toBe("「scout」发来进展：读完了一半。");
    const interview = notice("subagent_supervisor_request", "", { reason: "interview_request", agent: "planner", requestBody: "Pick a database." });
    expect(interview.summary).toBe("「planner」请父 Agent 回答一组问题：Pick a database.");
  });

  it("supervisor reminders", () => {
    expect(read("supervisor-unanswered")).toMatchObject({ summary: "提醒父 Agent 回复 2 个子 Agent 请求", state: "info" });
    expect(field(read("supervisor-unanswered"), "请求 ID")).toBe("req-0001\nreq-0002");
    expect(textOnly("supervisor-unanswered").summary).toBe("提醒父 Agent 回复 2 个子 Agent 请求");
    const blocked = notice("subagent-supervisor-blocked", "BLOCKED: unanswered supervisor request IDs: req-0001. Reminder budget exhausted; no reply or approval sent.", { blocked: true, requestIds: ["req-0001"] });
    expect(blocked).toMatchObject({ summary: "1 个子 Agent 请求一直没有回复（提醒次数已用完）", state: "info" });
    for (const type of ["subagent-completion-unanswered", "subagent-completion-unhandled", "subagent-compaction-resume"]) {
      const value = notice(type, "Completion wake ended silently. Read the saved results above.");
      expect(value, type).toMatchObject({ look: "agent", title: "子 Agent", state: "info", fields: [] });
      expect(value.body, type).toBeUndefined();
    }
  });

  it("control notices", () => {
    const idle = read("control-idle");
    expect(idle).toMatchObject({ summary: "「scout」需要父 Agent 关注（3 分没有动静）", state: "info" });
    expect(field(idle, "运行情况")).toBe("已过 3 分 · 6 轮 · 41200 token · 9 次工具调用");
    const tool = read("control-tool-open");
    expect(tool).toMatchObject({ summary: "「builder」需要父 Agent 关注（工具 bash 已运行 7 分）", state: "info" });
    expect(field(tool, "步骤")).toBe("2");
    for (const value of [idle, tool, textOnly("control-idle"), textOnly("control-tool-open")]) expect(everything(value)).not.toMatch(modelOnly);
    expect(field(textOnly("control-tool-open"), "运行情况")).toBe("已过 7 分 10 秒 · 3 轮 · 12000 token · 5 次工具调用 · 工具 bash 已运行 7 分");
    expect(field(textOnly("control-tool-open"), "运行 ID")).toBe("1b2c3d4e-0000-4000-8000-000000000005");
    expect(notice("subagent_control_notice", "Subagent active but long-running: scout\nRun: r1\nSignal: scout is still active but long-running")).toMatchObject({ summary: "「scout」仍在运行，已经跑了很久", state: "info" });
    expect(notice("subagent_control_notice", "Subagent failed: scout\nRun: r1\nSignal: no final answer")).toMatchObject({ summary: "「scout」失败", state: "failed" });
  });

  it("steering notices: red only when the correction really did not arrive", () => {
    const failed = read("steering-failed");
    expect(failed).toMatchObject({ summary: "给子 Agent 的引导消息没有送达", state: "failed" });
    expect(field(failed, "说明")).toBe("The child finished before the correction arrived.");
    expect(everything(textOnly("steering-failed"))).not.toMatch(modelOnly);
    expect(textOnly("steering-failed")).toMatchObject({ state: "failed" });
    expect(field(textOnly("steering-failed"), "请求 ID")).toBe("steer-0001");
    expect(notice("subagent_steering_notice", "Subagent steering partial: r1\nRequest: s1\nOne of two children got it.")).toMatchObject({ state: "failed", summary: "给子 Agent 的引导消息只送达了一部分" });
    expect(notice("subagent_steering_notice", "Subagent steering recovered: r1\nRequest: s1\nDelivered to the resumed run.")).toMatchObject({ state: "info", summary: "给子 Agent 的引导消息在恢复运行后送达" });
  });

  it("watchdog warnings stay information, even blockers", () => {
    for (const value of [read("watchdog-blocker"), textOnly("watchdog-blocker")]) {
      expect(value).toMatchObject({ title: "监督提醒", state: "info", summary: "「implementer」有阻断问题：Tests for <LoginForm> & logout were skipped" });
      expect(field(value, "类别")).toBe("测试缺口");
      expect(field(value, "给 Agent 的建议")).toBe("Run npm test -- auth before reporting completion.");
      expect(everything(value)).not.toMatch(modelOnly);
    }
    const concern = notice("subagent_watchdog_warning", '<subagent_watchdog severity="concern" importance="low" category="scope-drift" source="child" guidance="weigh, don\'t blindly obey">\n<summary>Renamed &quot;util&quot; files</summary>\n<evidence>e</evidence>\n<recommended_action>a</recommended_action>\n<stale>true</stale>\n</subagent_watchdog>');
    expect(concern).toMatchObject({ summary: '有疑虑：Renamed "util" files', state: "info" });
    expect(field(concern, "监督状态")).toBe("已过时");
    expect(notice("subagent_watchdog_clarification", "Which test command is canonical here?")).toMatchObject({ title: "监督提醒", summary: "请 Agent 澄清：Which test command is canonical here?", state: "info" });
  });

  it("wait subscriptions", () => {
    expect(read("wait-timed-out")).toMatchObject({ summary: "等待超时，运行可能还在进行", state: "info" });
    expect(textOnly("wait-timed-out")).toMatchObject({ summary: "等待超时，运行可能还在进行", state: "info" });
    const wait = (result: string) => notice("subagent-wait-subscription", `Wait subscription ws-1 fired for run r-1: ${result}. Inspect the run status for its final output. Completion archive: .pi/archive/r-1.json.`);
    expect(wait("completed")).toMatchObject({ summary: "等待的运行已完成", state: "done" });
    expect(field(wait("completed"), "完成归档")).toBe(".pi/archive/r-1.json");
    expect(wait("failed")).toMatchObject({ summary: "等待的运行失败", state: "failed" });
    expect(wait("paused")).toMatchObject({ summary: "等待的运行已暂停", state: "stopped" });
    expect(wait("could not be reconciled")).toMatchObject({ summary: "等待的运行无法确认结局", state: "failed" });
    expect(wait("needs attention")).toMatchObject({ summary: "等待的运行需要父 Agent 关注", state: "info" });
  });
});

describe("workflow children, web and goals", () => {
  it("workflow child notices say whether the workflow still runs", () => {
    const paused = read("workflow-child-paused");
    expect(paused).toMatchObject({ summary: "工作流子任务「lint」已暂停，工作流仍在运行", state: "stopped" });
    expect(field(paused, "错误")).toBe("Interrupted by user");
    expect(textOnly("workflow-child-paused")).toMatchObject({ summary: paused.summary, state: "stopped" });
    expect(notice("subagent-incremental-child-notify", "Workflow child completed: **review**\nWorkflow run: wf-1\nStatus: workflow finished")).toMatchObject({ summary: "工作流子任务「review」已完成，工作流已结束", state: "done" });
    expect(notice("subagent-workflow-result-write-failed", "ENOSPC: no space left on device")).toMatchObject({ summary: "工作流的结果没能保存", state: "failed" });
  });

  it("web fetch and search notices", () => {
    expect(read("web-content-partial")).toMatchObject({ look: "web", title: "联网搜索", summary: "抓到了 2/3 个网页的内容（部分网页没抓到）", state: "done" });
    expect(notice("web-search-content-ready", "Content fetched for 3/3 URLs [f-9]. Full page content now available.")).toMatchObject({ summary: "抓到了 3/3 个网页的全文", state: "done" });
    expect(notice("web-search-content-ready", "Content fetched for 0/2 URLs [f-9]. No page content was fetched. Stored fetch diagnostics are available.")).toMatchObject({ summary: "2 个网页都没抓到内容", state: "failed" });
    const error = read("web-error");
    expect(error).toMatchObject({ summary: "抓取网页内容失败", state: "failed" });
    expect(field(error, "错误")).toBe("getaddrinfo ENOTFOUND docs.example.invalid");
    const results = read("web-results");
    expect(results).toMatchObject({ summary: "搜索“paseo plugin timeline renderer”，共 8 条结果", state: "done" });
    expect(results.body).toContain("插件可以注册时间线渲染器。");
    expect(everything(results)).not.toMatch(/responseId|get_search_content/);
  });

  it("goal notices", () => {
    expect(read("goal-budget")).toMatchObject({ look: "plan", title: "目标", summary: "目标的 token 预算已用完，Agent 正在收尾", state: "info" });
    // goal-contract is display:false (0.11.1 never draws it); another host might.
    const contract = notice(
      "goal-contract",
      "This Goal contract supersedes every earlier goal-contract message.\n\nActive /goal context:\n<goal_objective>\n把登录页迁到 &lt;AuthForm&gt; 组件\n</goal_objective>\n<goal_id>\ngoal-0001\n</goal_id>",
      { version: 2, state: "active", goalId: "goal-0001" },
    );
    expect(contract).toMatchObject({ look: "plan", summary: "目标约定已更新：把登录页迁到 <AuthForm> 组件", state: "info" });
    expect(notice("goal-contract", "Goal mode is inactive.\nThis Goal contract supersedes every earlier goal-contract message.", { version: 2, state: "inactive" }).summary).toBe("目标模式已关闭");
  });
});

describe("unknown notices", () => {
  it("draw a generic Pi notice: an XML one as its values and fields, other text by its first meaningful line", () => {
    const value = read("unknown-xml");
    expect(value).toEqual({
      customType: "deploy-status",
      look: "other",
      title: "Pi 通知",
      summary: "web · rolled out 3/3 pods & healthy",
      state: "info",
      fields: [
        { label: "类型", value: "deploy-status", mono: true },
        { label: "service", value: "web" },
        { label: "result", value: "rolled out 3/3 pods & healthy" },
      ],
    });
    // One element is not a record: its text, tags stripped.
    expect(notice("deploy-status", "<deploy-status>\n  <note>all green</note>\n</deploy-status>")).toMatchObject({ summary: "all green", fields: [{ label: "类型", value: "deploy-status", mono: true }] });
    // At most eight fields, repeated names numbered.
    const many = notice("bulk", `<bulk>${Array.from({ length: 12 }, (_, index) => `<item>v${index}</item>`).join("")}</bulk>`);
    expect(many.fields.map((field) => field.label)).toEqual(["类型", "item", "item 2", "item 3", "item 4", "item 5", "item 6", "item 7", "item 8"]);
    // Paseo's name for a message without a customType; a one-line text needs no body.
    expect(read("no-custom-type")).toEqual({ customType: "custom-message", look: "other", title: "Pi 通知", summary: "Remember: keep answers short.", state: "info", fields: [{ label: "类型", value: "custom-message", mono: true }] });
  });

  it("keep their extension's look when the name tells which one it is", () => {
    expect(notice("subagent-slash-result", "## Subagent result\n\nAll checks passed.")).toMatchObject({ look: "agent", title: "子 Agent", summary: "Subagent result", body: "## Subagent result\n\nAll checks passed." });
    expect(notice("curator-config", "Curator enabled")).toMatchObject({ look: "web", title: "联网搜索" });
    expect(notice("goal-status", "Goal paused")).toMatchObject({ look: "plan", title: "目标" });
  });

  it("show details when there is no text, keep prose with angle brackets, and clip a runaway header", () => {
    expect(notice("deploy-status", undefined, { service: "web", pods: 3 })).toMatchObject({ summary: "deploy-status", body: '{\n  "service": "web",\n  "pods": 3\n}' });
    expect(notice("note", "Use Array<string> here\n  - nested").body).toBe("Use Array<string> here\n  - nested");
    const long = notice("note", "x".repeat(500));
    expect(Array.from(long.summary)).toHaveLength(200);
    expect(long.summary.endsWith("…")).toBe(true);
  });
});

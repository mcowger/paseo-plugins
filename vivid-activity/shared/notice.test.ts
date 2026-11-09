import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { wireRowFromEntry } from "./fold-index";
import { comparableResult, isForegroundNotice, noticeHeadline, noticeLook, noticeSections, noticeTextZh, parseNoticeSummary, readTaskNotice, rowResultText, sameResult } from "./notice";
import { createToolCallData } from "./timeline";

const notice = (label: string, status = "completed", metadata: Record<string, unknown> = {}) => ({
  name: "task_notification",
  status,
  detail: { type: "plain_text", label, icon: "wrench", text: label },
  metadata: { synthetic: true, source: "claude_task_notification", taskId: "b1x", toolUseId: "toolu_1", status, outputFile: "/tmp/b1x.output", ...metadata },
});

// Rows Paseo 0.11.1's own mapper builds from Claude Code 2.1.294-shaped records (artifacts/.../gen-notice-fixtures.mjs).
const fixtures = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/task-notices-0.11.1.json"), "utf8")) as {
  rows: Array<{ name: string; row: { name: string; status: string; detail: { label: string; text?: string }; metadata: Record<string, unknown> } }>;
};
const host = (name: string) => {
  const row = fixtures.rows.find((entry) => entry.name === name)?.row;
  if (!row) throw new Error(`no fixture ${name}`);
  return row;
};
/** The host's foreground repeat with another `<result>`, escaped the way Claude Code does (`&`, `<`, `>`). */
const repeatOf = (result: string) => {
  const row = host("foreground-repeat");
  const escaped = result.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return readTaskNotice({ ...row, detail: { ...row.detail, text: row.detail.text!.replace(/<result>[\s\S]*<\/result>/, () => `<result>\n${escaped}\n</result>`) } })!;
};
/** Claude Code 2.1.294's placeholder for a Bash call it moved to the background (its `IKt`, not on screen). */
const PLACEHOLDER =
  "[Still running. The user sent a message while this call loads, and that message follows so you can answer it now. This Bash call was not interrupted. Its result will be delivered to you on its own, in a later <task-notification> carrying this tool_use_id. Do not repeat the call, and do not wait, sleep or poll for it. You cannot stop it either, so never say you cancelled or dropped it. If they ask, it is still loading.]";

describe("Claude Code task notices", () => {
  it("reads Paseo's synthetic task_notification rows only", () => {
    expect(readTaskNotice({ name: "Bash", status: "completed", detail: { type: "shell" } })).toBeNull();
    expect(readTaskNotice({ ...notice("x"), metadata: { source: "other" } })).toBeNull();
    expect(readTaskNotice(notice("Probe the live web UI's route format without clicking"))).toEqual({
      ref: "toolu_1",
      taskId: "b1x",
      status: "completed",
      summary: "Probe the live web UI's route format without clicking",
      kind: "repeat",
      state: "done",
      subject: "Probe the live web UI's route format without clicking",
      outputFile: "/tmp/b1x.output",
      carriesResult: false,
      result: null,
      hostStatus: "completed",
    });
  });

  it("tells a foreground repeat of its own row from an event that stands on its own (opus-F51)", () => {
    // Older versions' description of a Bash with timeout only repeats the call's row.
    expect(isForegroundNotice(readTaskNotice(host("legacy-foreground")))).toBe(true);
    expect(isForegroundNotice(readTaskNotice(notice("列出项目依赖")))).toBe(true);
    // Without the call it belongs to there is nothing to fold into.
    expect(isForegroundNotice(readTaskNotice({ ...notice("列出项目依赖"), metadata: { source: "claude_task_notification" } }))).toBe(false);
    // 0.5 hid everything that did not start with "Background": a sub-agent's completion and failure vanished.
    for (const name of ["agent-finished", "agent-failed", "agent-killed", "agent-turn-limit", "agent-resumed", "monitor-event", "monitor-failed",
      "command-completed", "command-failed", "command-killed", "command-check-in", "command-waiting-input", "remote-blocked", "task-stopped", "queued-agent-finished"]) {
      expect(isForegroundNotice(readTaskNotice(host(name))), name).toBe(false);
    }
  });

  it("reads Claude Code 2.1's sub-agent notices: green when finished, red when failed, grey when stopped", () => {
    expect(readTaskNotice(host("agent-finished"))).toMatchObject({ kind: "agent", state: "done", status: "completed", subject: "审查登录模块", ref: "toolu_agent_1" });
    expect(readTaskNotice(host("agent-failed"))).toMatchObject({ kind: "agent", state: "failed", status: "failed", subject: "生成报告" });
    // The host maps Claude Code's "killed" to completed; the raw status still says it was stopped.
    expect(host("agent-killed").status).toBe("completed");
    expect(readTaskNotice(host("agent-killed"))).toMatchObject({ kind: "agent", state: "stopped", status: "canceled" });
    expect(readTaskNotice(host("agent-turn-limit"))).toMatchObject({ kind: "agent", state: "stopped", status: "canceled" });
    expect(readTaskNotice(host("agent-resumed"))).toMatchObject({ kind: "agent", state: "info", status: "completed", ref: null });
    expect(readTaskNotice(host("queued-agent-finished"))).toMatchObject({ kind: "agent", state: "done", subject: "写周报" });
  });

  it("reads monitors, background commands, remote tasks and stopped tasks", () => {
    expect(readTaskNotice(host("monitor-event"))).toMatchObject({ kind: "event", state: "info", subject: "dev server", ref: null });
    expect(readTaskNotice(host("monitor-failed"))).toMatchObject({ kind: "monitor", state: "failed", status: "failed", subject: "tail logs" });
    expect(readTaskNotice(host("command-completed"))).toMatchObject({ kind: "command", state: "done", outputFile: "/tmp/tasks/b1.output" });
    expect(readTaskNotice(host("command-failed"))).toMatchObject({ kind: "command", state: "failed", status: "failed" });
    expect(readTaskNotice(host("command-killed"))).toMatchObject({ kind: "command", state: "stopped", status: "canceled" });
    expect(readTaskNotice(host("command-check-in"))).toMatchObject({ kind: "command", state: "info", status: "completed" });
    expect(readTaskNotice(host("command-waiting-input"))).toMatchObject({ kind: "command", state: "blocked", status: "failed" });
    expect(readTaskNotice(host("remote-blocked"))).toMatchObject({ kind: "remote", state: "blocked", status: "failed" });
    expect(readTaskNotice(host("task-stopped"))).toMatchObject({ kind: "task", state: "stopped", status: "canceled", subject: "构建镜像" });
  });

  it("says it in Chinese", () => {
    const zh = (summary: string, status: "completed" | "failed" | "canceled" = "completed") => noticeTextZh({ summary, status });
    expect(zh('Background command "后台构建" completed (exit code 0)')).toBe("后台命令「后台构建」已完成（退出码 0）");
    expect(zh('Background command "lint" failed with exit code 1', "failed")).toBe("后台命令「lint」失败（退出码 1）");
    expect(zh('Background command "dev server" was stopped', "canceled")).toBe("后台命令「dev server」已停止");
    expect(zh('Background command "x" was stopped because the system is running low on memory', "canceled")).toBe("后台命令「x」已停止（内存不足）");
    expect(zh('Background command "watch" is still running after 10m 0s, with no new output for 4m 30s')).toBe("后台命令「watch」仍在运行（已运行 10m 0s，4m 30s 没有新输出）");
    expect(zh('Background agent "review" completed')).toBe("后台 Agent「review」已完成");
    expect(zh('Agent "审查登录模块" finished')).toBe("后台 Agent「审查登录模块」已完成");
    expect(zh('Agent "生成报告" failed: Unknown error', "failed")).toBe("后台 Agent「生成报告」失败：Unknown error");
    expect(zh('Agent "清理缓存" was stopped by user')).toBe("后台 Agent「清理缓存」被你停止");
    expect(zh('Agent "清理缓存" was stopped by Claude')).toBe("后台 Agent「清理缓存」被 Claude 停止");
    expect(zh('Agent "长任务" stopped at its 30-turn limit (partial result; SendMessage to task-id to continue)')).toBe("后台 Agent「长任务」到了 30 轮上限，停在半路（只有部分结果）");
    expect(zh('Monitor event: "dev server"')).toBe("监控事件「dev server」");
    expect(zh('Monitor event: "dev server" ready')).toBe("监控事件「dev server」：ready");
    expect(zh("Monitor event: dev server")).toBe("监控事件「dev server」");
    expect(zh('Monitor "tail logs" script failed (exit 2)', "failed")).toBe("监控「tail logs」脚本失败（退出码 2）");
    expect(zh('Remote task "修复 CI" is blocked: needs a GitHub token')).toBe("远程任务「修复 CI」卡住了：needs a GitHub token");
    expect(zh('Task "构建镜像" was stopped by the user')).toBe("后台任务「构建镜像」被你停止");
    expect(zh("The Bash call finished; its result follows. Carry on.")).toBe("前台调用「Bash」结果已送达");
    expect(zh("The Bash call ended without a result; what happened follows.", "failed")).toBe("前台调用「Bash」没有结果就结束了");
    expect(zh("Background task completed")).toBe("后台任务已完成");
    expect(zh("Background task failed", "failed")).toBe("后台任务失败");
    expect(zh("Background task notification")).toBe("后台任务通知");
    expect(zh("列出项目依赖")).toBe("列出项目依赖");
    expect(zh("")).toBe("后台任务已完成");
  });

  it("gives the row a title and a short summary, and a look by kind", () => {
    const headline = (name: string) => {
      const read = readTaskNotice(host(name))!;
      return noticeHeadline(read);
    };
    expect(headline("agent-finished")).toEqual({ title: "后台 Agent", summary: "「审查登录模块」已完成" });
    expect(headline("agent-failed")).toEqual({ title: "后台 Agent", summary: "「生成报告」失败：Unknown error" });
    expect(headline("monitor-event")).toEqual({ title: "监控事件", summary: "「dev server」" });
    expect(headline("command-completed")).toEqual({ title: "后台命令", summary: "「构建」已完成（退出码 0）" });
    expect(noticeLook("agent")).toBe("agent");
    expect(noticeLook("remote")).toBe("agent");
    expect(noticeLook("command")).toBe("shell");
    expect(noticeLook("event")).toBe("shell");
  });

  it("reads the agent's result, its usage, notes and events from the raw notification", () => {
    const finished = noticeSections(host("agent-finished").detail.text);
    expect(finished.result).toMatch(/^登录模块的审查结论：\n\n1\. 会话过期后/);
    expect(finished.usage).toEqual({ tokens: 48213, toolUses: 17, durationMs: 131500 });
    expect(noticeSections(host("agent-resumed").detail.text).note).toMatch(/^The user resumed this agent/);
    expect(noticeSections(host("monitor-event").detail.text).event).toBe("ready on :5173");
    expect(noticeSections(host("agent-failed").detail.text)).toEqual({ result: null, note: null, event: null, usage: null });
    // A plain summary (an older host, or a row without the raw text) has no sections.
    expect(noticeSections("Agent \"x\" finished")).toEqual({ result: null, note: null, event: null, usage: null });
    expect(noticeSections(undefined)).toEqual({ result: null, note: null, event: null, usage: null });
  });

  it("keeps the host's failed, killed and stopped over the summary's words, whatever the error quotes (codex-vivid-F2)", () => {
    // Rows from the host's own mapper; Claude Code keeps the quotes of an error in the summary.
    expect(readTaskNotice(host("agent-failed-quoted"))).toMatchObject({ kind: "agent", subject: "审查", state: "failed", status: "failed" });
    expect(noticeTextZh(readTaskNotice(host("agent-failed-quoted"))!)).toBe('后台 Agent「审查」失败：Hook "validate" finished with exit code 1');
    expect(readTaskNotice(host("agent-failed-quoted-stop"))).toMatchObject({ subject: "审查", state: "failed", status: "failed" });
    expect(noticeTextZh(readTaskNotice(host("agent-failed-quoted-stop"))!)).toBe('后台 Agent「审查」失败：Command "build" was stopped after exceeding its timeout');
    for (const name of ["agent-killed-quoted", "agent-stopped-quoted"]) {
      // The host records killed and stopped as completed; the raw status says how it ended.
      expect(host(name).status, name).toBe("completed");
      expect(readTaskNotice(host(name)), name).toMatchObject({ subject: "审查", state: "stopped", status: "canceled" });
      expect(noticeTextZh(readTaskNotice(host(name))!), name).toBe('后台 Agent「审查」已停止：Hook "validate" finished with exit code 1');
    }
    // Summary words that contradict the status give way to it.
    const failed = readTaskNotice(notice('Agent "x" finished', "failed"))!;
    expect(failed).toMatchObject({ state: "failed", status: "failed" });
    expect(noticeHeadline(failed)).toEqual({ title: "后台 Agent", summary: "「x」失败" });
    expect(readTaskNotice(notice('Agent "x" failed: boom', "killed"))).toMatchObject({ state: "stopped", status: "canceled" });
    // Only a completed notice reads its ending from the template.
    expect(readTaskNotice(host("agent-turn-limit"))).toMatchObject({ state: "stopped", status: "canceled" });
    // A name with quotes of its own still ends at the quote a state word follows.
    expect(readTaskNotice(notice('Agent "fix "login" bug" finished'))).toMatchObject({ subject: 'fix "login" bug', state: "done" });
  });

  it("ends a quoted name where the template and the host's status say, whatever state words the name or the reason hold (codex-vivid-F5)", () => {
    // Codex's name-quotes.mjs (names with state words, host status completed) and the first round's quoted-error.mjs
    // (reasons with state words), plus a failed, a killed and a monitor name and two reasons that end like a template;
    // every row from the host's own mapper.
    const cases: Array<[fixture: string, subject: string, state: string, status: string, text: string]> = [
      ["agent-name-quotes-finished", 'Investigate why "build" failed', "done", "completed", '后台 Agent「Investigate why "build" failed」已完成'],
      ["command-name-quotes-completed", 'Explain why "worker" was stopped', "done", "completed", '后台命令「Explain why "worker" was stopped」已完成（退出码 0）'],
      ["agent-name-quotes-turn-limit", 'Investigate why "job" finished early', "stopped", "canceled", '后台 Agent「Investigate why "job" finished early」到了 30 轮上限，停在半路（只有部分结果）'],
      ["agent-name-quotes-failed", 'Why "build" finished', "failed", "failed", '后台 Agent「Why "build" finished」失败：Hook "validate" finished with exit code 1'],
      ["command-name-quotes-killed", 'Restart "api" completed', "stopped", "canceled", '后台命令「Restart "api" completed」已停止'],
      ["monitor-name-quotes-failed", 'tail "app" stream ended', "failed", "failed", '监控「tail "app" stream ended」脚本失败（退出码 2）'],
      ["agent-failed", "生成报告", "failed", "failed", "后台 Agent「生成报告」失败：Unknown error"],
      ["agent-failed-quoted", "审查", "failed", "failed", '后台 Agent「审查」失败：Hook "validate" finished with exit code 1'],
      ["agent-failed-quoted-stop", "审查", "failed", "failed", '后台 Agent「审查」失败：Command "build" was stopped after exceeding its timeout'],
      ["agent-killed-quoted", "审查", "stopped", "canceled", '后台 Agent「审查」已停止：Hook "validate" finished with exit code 1'],
      ["agent-stopped-quoted", "审查", "stopped", "canceled", '后台 Agent「审查」已停止：Hook "validate" finished with exit code 1'],
      // The reason itself ends like a template (「was stopped」, 「finished」): the host's status picks the failure's ending.
      ["agent-failed-ending-quoted", "部署", "failed", "failed", '后台 Agent「部署」失败：worker "sync" was stopped'],
      ["agent-killed-ending-quoted", "部署", "stopped", "canceled", '后台 Agent「部署」已停止：Task "sync" finished'],
    ];
    for (const [fixture, subject, state, status, text] of cases) {
      const row = host(fixture);
      const read = readTaskNotice(row)!;
      expect(read, fixture).toMatchObject({ subject, state, status });
      expect(noticeTextZh(read), fixture).toBe(text);
      // The row the timeline draws and the fold index's status say the same.
      const data = createToolCallData(row as never);
      expect(data.status, fixture).toBe(status);
      expect(data.presentation.summary, fixture).toBe(text.replace(/^(后台 Agent|后台命令|监控)/, ""));
      expect(wireRowFromEntry({ provider: "claude", seqStart: 1, timestamp: "2026-10-13T00:00:00.000Z", item: row })?.st, fixture).toBe(status);
    }
    // Without the host's status the template still finds the ending from the end of the summary.
    expect(readTaskNotice(notice('Agent "Investigate why "job" finished early" stopped at its 30-turn limit (partial result)', "completed", { status: undefined }))).toMatchObject({ subject: 'Investigate why "job" finished early', state: "stopped" });
    // An ending no template knows falls back to the first closing quote a state word follows.
    expect(readTaskNotice(notice('Agent "x" was paused by the scheduler'))).toMatchObject({ subject: "x" });
  });

  it("folds a repeat only when its row's final result reads the same as its own (0.6.0-local.4, codex-vivid-F7)", () => {
    const repeat = readTaskNotice(host("foreground-repeat"))!;
    expect(repeat).toMatchObject({ kind: "repeat", carriesResult: true, result: "built in 4.2s" });
    // The same text: colour codes, CRLF, spaces at the end of a line and blank lines at either end do not count.
    for (const output of ["built in 4.2s", "built in 4.2s\n", "\u001b[32mbuilt in 4.2s\u001b[0m", "built in 4.2s  \r\n\r\n", "\n\nbuilt in 4.2s \t\n"]) {
      expect(isForegroundNotice(repeat, comparableResult(output)), JSON.stringify(output)).toBe(true);
    }
    // Anything else keeps the notice on its own row: more lines around it, other spaces in a line, other line breaks.
    for (const output of ["build started\nbuilt in 4.2s\n2 warnings", "built  in 4.2s", "built in\n4.2s", " built in 4.2s", "built in 3.9s"]) {
      expect(isForegroundNotice(repeat, comparableResult(output)), JSON.stringify(output)).toBe(false);
    }
    expect(isForegroundNotice(repeat, null)).toBe(false);
    expect(isForegroundNotice(repeat)).toBe(false);
    // Without a result of its own a repeat folds as before.
    expect(isForegroundNotice(readTaskNotice(host("legacy-foreground")), null)).toBe(true);
    // The notice's result keeps the spaces that start it (Claude Code puts it on lines of its own); escapes are undone.
    expect(repeatOf("  indented\nnext").result).toBe("  indented\nnext");
    expect(isForegroundNotice(repeatOf("  indented\nnext"), comparableResult("  indented\nnext\n"))).toBe(true);
    expect(repeatOf("a <b> & c").result).toBe("a <b> & c");
    expect(readTaskNotice(notice("The Bash call finished; its result follows.", "completed", {}))!.result).toBeNull();
    // The row's result as text.
    expect(rowResultText({ detail: { type: "shell", command: "ls", output: "a <b> & c" } })).toBe("a <b> & c");
    expect(rowResultText({ detail: { type: "unknown", output: { ok: true } } })).toBe('{"ok":true}');
    expect(rowResultText({ detail: { type: "shell", command: "ls" }, error: { message: "boom" } })).toBe("boom");
    expect(rowResultText({ detail: { type: "shell", command: "ls" } })).toBeNull();
    expect(comparableResult("")).toBeNull();
    expect(comparableResult(" \n\t\n")).toBeNull();
  });

  it("keeps every notice Codex's recheck saw folded by mistake (codex-vivid-F7)", () => {
    // review/scratch/codex/recheck-71e8ea7/merge/check-merge.mjs: each was hidden because the row's text held the
    // notice's somewhere once spaces were squeezed, or because two long results shared a start.
    const cases: Array<[name: string, row: string, result: string]> = [
      ["a word of the placeholder", PLACEHOLDER, "running"],
      ["another word of it", PLACEHOLDER, "it"],
      ["the placeholder itself", PLACEHOLDER, PLACEHOLDER],
      ["the placeholder of a call on screen", PLACEHOLDER.replace(" If they ask", " On the user's screen this call simply still shows as in progress. If they ask"), "loading"],
      ["a background start note", "Command running in background with ID: b1. Output is being written to: /tmp/b1.output", "Command running in background with ID: b1. Output is being written to: /tmp/b1.output"],
      ["the start of a number", "errors: 10", "errors: 1"],
      ["spaces inside a JSON string", '{"text":"a  b"}', '{"text":"a b"}'],
      ["line breaks", "1\n23", "1 23"],
      ["a long common start", `${"x".repeat(200_000)} SOURCE`, `${"x".repeat(200_000)} DIFFERENT FINAL RESULT`],
      ["the same, past the budget", "x".repeat(200_001), "x".repeat(200_001)],
      ["a short result past the row's budget", `${"x".repeat(200_001)} target`, "target"],
    ];
    for (const [name, output, result] of cases) {
      const read = repeatOf(result);
      expect(read.result, name).toBe(result);
      expect(isForegroundNotice(read, comparableResult(output)), name).toBe(false);
      expect(sameResult(comparableResult(output), result), name).toBe(false);
    }
    // A placeholder is never compared at all, nor is anything over the budget.
    expect(comparableResult(PLACEHOLDER)).toBeNull();
    expect(comparableResult(`\u001b[2m${PLACEHOLDER}\u001b[0m\n`)).toBeNull();
    expect(comparableResult("x".repeat(200_001))).toBeNull();
    expect(comparableResult("x".repeat(200_000))).toEqual({ text: "x".repeat(200_000) });
    // Reading stays linear: 200 000 characters of short coloured lines.
    const lines = "\u001b[32mok\u001b[0m  \r\n".repeat(13_000);
    const started = performance.now();
    expect(comparableResult(lines)?.text.split("\n")).toHaveLength(13_000);
    expect(sameResult(comparableResult(lines), lines.replaceAll("\u001b[32m", "").replaceAll("\u001b[0m", ""))).toBe(true);
    // Wall clock, generous (a quiet run parses in a few ms): the guard catches quadratic reading; the suite itself
    // runs under parallel load, which pushed a bare 100 ms bound over the edge on every full run.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("reads the ending of a long name from the end of the whole summary, then shortens the name (codex-vivid-F8)", () => {
    // review/scratch/codex/recheck-71e8ea7/notice/edge-cases.mjs: the summary was cut to 2 000 characters before it was
    // read, so a 2 010-character name lost its ending, and words left in the cut name decided the state.
    const long = "x".repeat(2_010);
    const shownLong = `${"x".repeat(2_000)}…`;
    const cases: Array<[fixture: string, subject: string, state: string, status: string, words: string]> = [
      ["agent-long-name-turn-limit", shownLong, "stopped", "canceled", "到了 30 轮上限，停在半路（只有部分结果）"],
      ["agent-long-name-finished", `Investigate why "job" failed ${long}`.slice(0, 2_000) + "…", "done", "completed", "已完成"],
      ["agent-long-name-quoted-turn-limit", `Investigate why "job" finished early ${long}`.slice(0, 2_000) + "…", "stopped", "canceled", "到了 30 轮上限，停在半路（只有部分结果）"],
      ["agent-long-name-failed", shownLong, "failed", "failed", '失败：Hook "validator" finished'],
      ["agent-long-reason-failed", 'Inspect "job" finished', "failed", "failed", `失败：${long} Task "inner" finished`.slice(0, 2_000) + "…"],
    ];
    for (const [fixture, subject, state, status, words] of cases) {
      const row = host(fixture);
      expect(row.detail.label.length, fixture).toBeGreaterThan(2_000);
      const read = readTaskNotice(row)!;
      expect(read, fixture).toMatchObject({ kind: "agent", subject, state, status });
      expect(noticeTextZh(read), fixture).toBe(`后台 Agent「${subject}」${words}`);
      expect(createToolCallData(row as never).status, fixture).toBe(status);
      expect(wireRowFromEntry({ provider: "claude", seqStart: 1, timestamp: "2026-10-13T00:00:00.000Z", item: row })?.st, fixture).toBe(status);
    }
  });

  it("takes the host's status when no ending Claude Code writes is found, not words of the name (codex-vivid-F8)", () => {
    // An ending no template knows: 「failed」 in the name says nothing; the host said completed.
    const unknown = 'Agent "Investigate why "job" failed" was paused by the scheduler';
    expect(readTaskNotice(notice(unknown))).toMatchObject({ state: "done", status: "completed" });
    expect(noticeTextZh(readTaskNotice(notice(unknown))!)).not.toContain("失败");
    expect(readTaskNotice(notice(unknown, "failed"))).toMatchObject({ state: "failed", status: "failed" });
    expect(parseNoticeSummary(unknown, null, "completed")).toMatchObject({ kind: "agent", state: null, tail: "" });
    // A name past the part read for it, with a reason past it too: the ending is out of reach, so the host decides.
    const both = `Agent "Why "job" failed ${"x".repeat(5_000)}" failed: ${"y".repeat(5_000)}`;
    expect(readTaskNotice(notice(both, "completed"))).toMatchObject({ state: "done", status: "completed" });
    expect(readTaskNotice(notice(both, "failed"))).toMatchObject({ state: "failed", status: "failed" });
    // A free ending past the part read for the name is still found near the end.
    const far = `Agent "${"x".repeat(5_000)}" failed: Hook "validator" finished`;
    expect(noticeTextZh(readTaskNotice(notice(far, "failed"))!)).toBe(`后台 Agent「${"x".repeat(2_000)}…」失败：Hook "validator" finished`);
  });

  it("reads the ending after an empty or all-blank name, and shows the generic title (codex-vivid-F9)", () => {
    // review/scratch/codex/recheck-f541232/notice/empty-name.mjs: Claude Code's Agent tool takes an empty description (and
    // turns an all-blank one into it). A name had to be at least one character, so `Agent "" stopped at its 30-turn
    // limit (…)` lost its ending, read as finished, and showed the ending as its name. Rows from the host's own mapper.
    const endings: Array<[ending: string, state: string, status: string, words: string]> = [
      ["finished", "done", "completed", "已完成"],
      ["turn-limit", "stopped", "canceled", "到了 30 轮上限，停在半路（只有部分结果）"],
      ["failed", "failed", "failed", "失败：Unknown error"],
      ["killed", "stopped", "canceled", "已停止"],
      ["stopped", "stopped", "canceled", "被你停止"],
    ];
    for (const name of ["empty", "blank"]) {
      for (const [ending, state, status, words] of endings) {
        const fixture = `agent-${name}-name-${ending}`;
        const row = host(fixture);
        const read = readTaskNotice(row)!;
        expect(read, fixture).toMatchObject({ kind: "agent", subject: null, state, status });
        expect(noticeTextZh(read), fixture).toBe(`后台 Agent ${words}`);
        // The row the timeline draws and the fold index's status say the same.
        const data = createToolCallData(row as never);
        expect(data.status, fixture).toBe(status);
        expect(data.presentation, fixture).toMatchObject({ label: "后台 Agent", summary: words });
        expect(wireRowFromEntry({ provider: "claude", seqStart: 1, timestamp: "2026-10-13T00:00:00.000Z", item: row })?.st, fixture).toBe(status);
      }
    }
    // A free ending right after an empty name, with a reason too long for the end of the summary to hold it.
    const reason = "e".repeat(600);
    expect(noticeTextZh(readTaskNotice(notice(`Agent "" failed: ${reason}`, "failed"))!)).toBe(`后台 Agent 失败：${reason}`);
    expect(noticeTextZh(readTaskNotice(notice(`Agent "" was stopped: ${reason}`, "killed"))!)).toBe(`后台 Agent 已停止：${reason}`);
    // An ending no template knows after an empty name: no name, and the host's status; the ending is never the name.
    expect(readTaskNotice(notice('Agent "" was paused by the scheduler'))).toMatchObject({ kind: "agent", subject: null, state: "done" });
    expect(noticeTextZh(readTaskNotice(notice('Agent "" was paused by the scheduler'))!)).toBe("后台 Agent 已完成");
    expect(readTaskNotice(notice('Agent "" was paused by "scheduler" today'))).toMatchObject({ subject: null, state: "done" });
    expect(readTaskNotice(notice('Agent "x" paused'))).toMatchObject({ subject: "x", state: "done" });
    // Other kinds the same.
    expect(noticeTextZh(readTaskNotice(notice('Background command "" completed (exit code 0)'))!)).toBe("后台命令已完成（退出码 0）");
    expect(readTaskNotice(notice('Monitor "" script failed (exit 2)', "failed"))).toMatchObject({ kind: "monitor", subject: null, state: "failed" });
  });

  it("reads a summary of any length in bounded time", () => {
    const cases = [
      `Agent "${"x".repeat(1_000_000)}" finished`,
      `Background command "x" is still running after ${", with no new output for a".repeat(6_000)}"`,
      `Agent "${'a" failed: '.repeat(100_000)}" finished`,
      `Monitor event: "${"m".repeat(500_000)}`,
    ];
    for (const summary of cases) {
      const started = performance.now();
      const read = readTaskNotice(notice(summary));
      noticeTextZh(read!);
      expect(performance.now() - started, summary.slice(0, 40)).toBeLessThan(100);
      expect(noticeTextZh(read!).length).toBeLessThan(2_100);
    }
  });

  it("keeps a detached foreground call's result: its notice stands on its own row (0.6.0-local.2)", () => {
    for (const name of ["foreground-repeat", "detached-finished", "detached-failed"]) {
      const read = readTaskNotice(host(name))!;
      expect(read, name).toMatchObject({ kind: "repeat", carriesResult: true });
      expect(isForegroundNotice(read), name).toBe(false);
    }
    expect(noticeHeadline(readTaskNotice(host("detached-finished"))!)).toEqual({ title: "前台调用", summary: "「Bash」结果已送达" });
    expect(noticeSections(host("detached-finished").detail.text).result).toBe("✓ 312 tests passed");
    expect(readTaskNotice(host("detached-failed"))).toMatchObject({ state: "failed", status: "failed" });
    expect(noticeHeadline(readTaskNotice(host("detached-failed"))!)).toEqual({ title: "前台调用", summary: "「Bash」没有结果就结束了" });
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it, vi } from "vitest";
import type { FoldIndexInput, FoldIndexOutput, WireRow } from "../shared/fold-index";
import { reasoningKey } from "../shared/fold";
import { foldRuntime } from "./fold-runtime";
import { readPiNotice } from "../shared/pi-notice";
import { setPiNoticeReader, type PiNoticeReader } from "../shared/timeline";
import { configurePiNotices, fingerprint, observeBoundary, retryPiNotices, transformReasoning, transformToolCall } from "./transform";

// Rows Paseo 0.11.1's own mapper builds from Claude Code 2.1.294-shaped notices (shared/notice.test.ts).
const notices = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/task-notices-0.11.1.json"), "utf8")) as {
  rows: Array<{ name: string; row: Record<string, unknown> }>;
};

let time = 5_000_000;
const timers = new Map<number, { at: number; run: () => void }>();
let handles = 0;
let nudges = 0;
const index: WireRow[] = [];
foldRuntime.configure({
  rpc: async (input: FoldIndexInput): Promise<FoldIndexOutput> => ({
    status: "ok",
    epoch: "e",
    rows: input.direction === "tail" ? index : [],
    startCursor: { epoch: "e", seq: 1 },
    endCursor: { epoch: "e", seq: 99 },
    hasOlder: false,
    hasNewer: false,
    reset: false,
    running: false,
  }),
  nudge: () => void nudges++,
  now: () => time,
  setTimer: (run, ms) => {
    timers.set(++handles, { at: time + ms, run });
    return handles;
  },
  clearTimer: (handle) => void timers.delete(handle as number),
});
async function advance(ms: number) {
  const end = time + ms;
  for (;;) {
    for (let step = 0; step < 8; step++) await Promise.resolve();
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    time = due[1].at;
    due[1].run();
  }
  time = end;
}

const call = (callId: string, detail: ToolCallDetail, status: "running" | "completed" | "failed" = "completed", extra: Record<string, unknown> = {}) => ({
  type: "tool_call" as const,
  callId,
  name: detail.type === "shell" ? "Bash" : "Read",
  detail,
  status,
  error: status === "failed" ? { message: "boom" } : null,
  ...extra,
}) as Parameters<typeof transformToolCall>[0]["item"];
const kindsOf = (result: ReturnType<typeof transformToolCall>) => result?.items.map((item) => item.kind);

describe("timeline transforms with folding", () => {
  it("hides folded rows entirely, puts the summary on the first row, and expands on request", async () => {
    const a = call("fold-a", { type: "shell", command: "npm test" });
    const b = call("fold-b", { type: "read", filePath: "src/a.ts" });
    const c = call("fold-c", { type: "shell", command: "npm run lint" });
    for (const item of [a, b, c]) expect(kindsOf(transformToolCall({ item, phase: "complete" }))).toEqual(["colorful-tool-call"]);
    index.push(
      { s: 1, at: 1000, k: "b", w: "user_message" },
      { s: 2, at: 2000, k: "t", key: "t:fold-a", st: "completed", look: "shell" },
      { s: 3, at: 3000, k: "t", key: "t:fold-b", st: "completed", look: "read" },
      { s: 4, at: 4000, k: "t", key: "t:fold-c", st: "completed", look: "shell" },
      { s: 5, at: 9000, k: "b", w: "assistant_message" },
    );
    foldRuntime.acquire("agent-fold");
    await advance(1_000);
    expect(nudges).toBe(1);
    const summary = transformToolCall({ item: a, phase: "complete" });
    expect(summary?.items).toEqual([
      {
        type: "plugin",
        kind: "vivid-fold",
        version: 1,
        data: {
          segment: "2", mode: "done", expanded: false, steps: 3, hidden: 3, counts: [["shell", 2], ["read", 1]], failed: 0, canceled: 0, durationMs: 3000, endedAt: 4000,
          files: 0, added: 0, removed: 0, uncounted: 0, changed: [], fails: [], turn: null, lastOfTurn: false,
        },
      },
    ]);
    expect(transformToolCall({ item: b, phase: "complete" })).toEqual({ items: [] });
    // A row that is still running never disappears, whatever a lagging index says.
    expect(kindsOf(transformToolCall({ item: { ...c, status: "running" } as typeof c, phase: "streaming" }))).toEqual(["colorful-tool-call"]);
    foldRuntime.toggle("agent-fold", "2", true);
    await advance(0);
    expect(nudges).toBe(2);
    expect(kindsOf(transformToolCall({ item: a, phase: "complete" }))).toEqual(["vivid-fold", "colorful-tool-call"]);
    expect(kindsOf(transformToolCall({ item: b, phase: "complete" }))).toEqual(["colorful-tool-call"]);
    foldRuntime.release("agent-fold");
  });

  it("folds a foreground task notice into its command and draws a background one as its own row", () => {
    const bash = call("note-bash", { type: "shell", command: "npm ls" });
    transformToolCall({ item: bash, phase: "complete" });
    const notice = (label: string, callId: string, ref = "note-bash") =>
      ({
        type: "tool_call",
        callId,
        name: "task_notification",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label, icon: "wrench", text: label },
        metadata: { synthetic: true, source: "claude_task_notification", toolUseId: ref, taskId: "b9", outputFile: "/tmp/b9.output" },
      }) as unknown as Parameters<typeof transformToolCall>[0]["item"];
    expect(transformToolCall({ item: notice("列出项目依赖", "task_notification_fg"), phase: "complete" })).toEqual({ items: [] });
    // The same foreground notice whose command Paseo never loaded stays visible.
    expect(kindsOf(transformToolCall({ item: notice("列出项目依赖", "task_notification_orphan", "unknown-call"), phase: "complete" }))).toEqual(["colorful-tool-call"]);
    const background = transformToolCall({ item: notice('Background command "构建" completed (exit code 0)', "task_notification_bg"), phase: "complete" });
    expect(background?.items[0]?.data).toMatchObject({
      name: "task_notification",
      notice: { text: "后台命令「构建」已完成（退出码 0）", kind: "command", state: "done", taskId: "b9", outputFile: "/tmp/b9.output" },
      presentation: { category: "shell", icon: "SquareTerminal", label: "后台命令", summary: "「构建」已完成（退出码 0）" },
    });
    // 0.6.0 (opus-F51): Claude Code 2.1's sub-agent notices refer to the Agent call too, but are never folded into it.
    const agent = call("note-agent", { type: "sub_agent", subAgentType: "general-purpose", description: "审查登录模块", log: "" });
    transformToolCall({ item: agent, phase: "complete" });
    const finished = transformToolCall({ item: notice('Agent "审查登录模块" finished', "task_notification_agent", "note-agent"), phase: "complete" });
    expect(finished?.items[0]?.data).toMatchObject({
      status: "completed",
      notice: { kind: "agent", state: "done", text: "后台 Agent「审查登录模块」已完成" },
      presentation: { category: "agent", icon: "Bot", label: "后台 Agent", summary: "「审查登录模块」已完成" },
    });
    const failed = transformToolCall({ item: { ...notice('Agent "审查登录模块" failed: Unknown error', "task_notification_agent_failed", "note-agent"), status: "failed" }, phase: "complete" });
    expect(failed?.items[0]?.data).toMatchObject({ status: "failed", notice: { kind: "agent", state: "failed" }, presentation: { summary: "「审查登录模块」失败：Unknown error" } });
    // 0.6.0-local.2 (codex-vivid-F2): a quoted error reason does not turn a failed notice into a finished one.
    const quoted = 'Agent "审查" failed: Hook "validate" finished with exit code 1';
    const hook = transformToolCall({ item: { ...notice(quoted, "task_notification_quoted", "note-agent"), status: "failed", metadata: { synthetic: true, source: "claude_task_notification", toolUseId: "note-agent", status: "failed" } } as typeof agent, phase: "complete" });
    expect(hook?.items[0]?.data).toMatchObject({ status: "failed", notice: { state: "failed" }, presentation: { summary: '「审查」失败：Hook "validate" finished with exit code 1' } });
  });

  it("draws a detached foreground call's notice as its own row: it carries the call's real result (0.6.0-local.2)", () => {
    // The call's own row holds Claude Code's 「Still running」 placeholder; the notice brings the result.
    const bash = call("detached-bash", { type: "shell", command: "npm test", output: "[Still running. The user sent a message while this call loads…]" });
    transformToolCall({ item: bash, phase: "complete" });
    const raw = "<task-notification>\n<tool-use-id>detached-bash</tool-use-id>\n<task-type>tool_call</task-type>\n<status>completed</status>\n<summary>The Bash call finished; its result follows. Carry on from it as if the tool had just returned.</summary>\n<result>\n✓ 312 tests passed\n</result>\n</task-notification>";
    const item = {
      type: "tool_call",
      callId: "task_notification_detached",
      name: "task_notification",
      status: "completed",
      error: null,
      detail: { type: "plain_text", label: "The Bash call finished; its result follows. Carry on from it as if the tool had just returned.", icon: "wrench", text: raw },
      metadata: { synthetic: true, source: "claude_task_notification", toolUseId: "detached-bash", status: "completed" },
    } as unknown as Parameters<typeof transformToolCall>[0]["item"];
    const shown = transformToolCall({ item, phase: "complete" });
    expect(kindsOf(shown)).toEqual(["colorful-tool-call"]);
    expect(shown?.items[0]?.data).toMatchObject({ notice: { kind: "repeat", state: "done" }, presentation: { label: "前台调用", summary: "「Bash」结果已送达" } });
  });

  describe("a foreground repeat with a result of its own (0.6.0-local.3, 0.6.0-local.4)", () => {
    // The fixture is the host's own row for Claude Code's template that says the result just landed in the call's row.
    const repeat = notices.rows.find((row) => row.name === "foreground-repeat")!.row as unknown as Parameters<typeof transformToolCall>[0]["item"];
    const notice = (id: string, result?: string, callId = `task_notification_${id}`) => {
      const detail = repeat.detail as { text: string };
      const escaped = result?.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const text = escaped === undefined ? detail.text : detail.text.replace(/<result>[\s\S]*<\/result>/, () => `<result>\n${escaped}\n</result>`);
      return { ...repeat, callId, detail: { ...detail, text }, metadata: { ...(repeat.metadata as object), toolUseId: id } } as unknown as typeof repeat;
    };
    const shell = (id: string, output: string) => transformToolCall({ item: call(id, { type: "shell", command: "npm run build", output }), phase: "complete" });
    const placeholder =
      "[Still running. The user sent a message while this call loads, and that message follows so you can answer it now. This Bash call was not interrupted. Its result will be delivered to you on its own, in a later <task-notification> carrying this tool_use_id. Do not repeat the call, and do not wait, sleep or poll for it. You cannot stop it either, so never say you cancelled or dropped it. If they ask, it is still loading.]";

    it("folds it when its row's final result reads the same, both `built in 4.2s`, and keeps any other", () => {
      const ref = (repeat.metadata as { toolUseId: string }).toolUseId;
      shell(ref, "built in 4.2s\n");
      expect(kindsOf(transformToolCall({ item: repeat, phase: "complete" }))).toEqual([]);
      // The same text in colour folds too.
      shell("colour-bash", "\u001b[32mbuilt in 4.2s\u001b[0m\r\n");
      expect(kindsOf(transformToolCall({ item: notice("colour-bash"), phase: "complete" }))).toEqual([]);
      // More around it, another result, or a row that only holds the placeholder: the notice keeps its own row.
      for (const [id, output] of [["more-bash", "built in 4.2s\n2 warnings"], ["other-bash", "built in 3.9s"], ["held-bash", placeholder]] as const) {
        shell(id, output);
        expect(kindsOf(transformToolCall({ item: notice(id), phase: "complete" })), id).toEqual(["colorful-tool-call"]);
      }
      // The row's result changed since: read again, not the old reading.
      shell("changed-bash", "built in 3.9s");
      expect(kindsOf(transformToolCall({ item: notice("changed-bash"), phase: "complete" }))).toEqual(["colorful-tool-call"]);
      shell("changed-bash", "built in 4.2s");
      expect(kindsOf(transformToolCall({ item: notice("changed-bash", "built in 4.2s", "task_notification_changed-bash-2"), phase: "complete" }))).toEqual([]);
      // The fold plan hears each decision (it follows the client's over the index's, which may not see the row).
      const noted = vi.spyOn(foldRuntime, "noteNotice");
      transformToolCall({ item: repeat, phase: "complete" });
      transformToolCall({ item: notice("other-bash"), phase: "complete" });
      expect(noted.mock.calls).toEqual([[`t:${repeat.callId}`, true], ["t:task_notification_other-bash", false]]);
      noted.mockRestore();
    });

    it("keeps every notice Codex's recheck saw folded by mistake (codex-vivid-F7)", () => {
      const cases: Array<[row: string, result: string]> = [
        [placeholder, "running"],
        [placeholder, "it"],
        [placeholder, placeholder],
        ["errors: 10", "errors: 1"],
        ['{"text":"a  b"}', '{"text":"a b"}'],
        ["1\n23", "1 23"],
        [`${"x".repeat(200_000)} SOURCE`, `${"x".repeat(200_000)} DIFFERENT FINAL RESULT`],
        ["x".repeat(200_001), "x".repeat(200_001)],
      ];
      cases.forEach(([output, result], index) => {
        shell(`codex-${index}`, output);
        expect(kindsOf(transformToolCall({ item: notice(`codex-${index}`, result), phase: "complete" })), result.slice(0, 30)).toEqual(["colorful-tool-call"]);
      });
    });

    it("reads a row's result once for all the notices that repeat it (codex-vivid-F7)", () => {
      shell("big-bash", "\u001b[32mok\u001b[0m  \r\n".repeat(13_000));
      const started = performance.now();
      for (let index = 0; index < 400; index++) {
        expect(kindsOf(transformToolCall({ item: notice("big-bash", `ok ${index}`, `task_notification_big_${index}`), phase: "complete" }))).toEqual(["colorful-tool-call"]);
      }
      // 墙钟放宽（安静时 ~100ms）：守卫抓的是二次退化（数量级差异），并行满载下 400ms 会误报。
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  it("reuses the transform of a finished row and redoes it when the row changes", () => {
    const item = call("memo-1", { type: "shell", command: "ls", output: "a\nb" });
    const first = transformToolCall({ item, phase: "complete" });
    expect(transformToolCall({ item: { ...item }, phase: "complete" })).toBe(first);
    const changed = transformToolCall({ item: { ...item, detail: { type: "shell", command: "ls", output: "a\nb\nc" } } as typeof item, phase: "complete" });
    expect(changed).not.toBe(first);
    expect(fingerprint({ a: "x".repeat(40), b: [1, 2], c: { d: { e: 1 } } })).toBe(`{a=40:${"x".repeat(24)}${"x".repeat(8)};b=[1,2];c={d=o1}}`);
    const reasoning = transformReasoning({ item: { type: "reasoning", text: "先读文件" }, phase: "complete" });
    expect(transformReasoning({ item: { type: "reasoning", text: "先读文件" }, phase: "complete" })).toBe(reasoning);
    expect(reasoning?.items[0]?.data).toMatchObject({ fold: reasoningKey("先读文件") });
  });

  it("only watches boundary items, never claims them", () => {
    expect(observeBoundary()).toBeUndefined();
  });

  it("records a reasoning row as drawn once it is finished, not every chunk of it while it streams (0.5.0)", () => {
    const seenBefore = foldRuntime.debugMemory().seen;
    let text = "";
    for (const chunk of ["先", "读", "一下", "配置文件"]) {
      text += chunk;
      expect(kindsOf(transformReasoning({ item: { type: "reasoning", text }, phase: "streaming" }))).toEqual(["colorful-reasoning"]);
      expect(foldRuntime.hasSeen(reasoningKey(text))).toBe(false);
    }
    expect(foldRuntime.debugMemory().seen).toBe(seenBefore);
    transformReasoning({ item: { type: "reasoning", text }, phase: "complete" });
    expect(foldRuntime.hasSeen(reasoningKey(text))).toBe(true);
    expect(foldRuntime.debugMemory().seen).toBe(seenBefore + 1);
  });

  it("leaves Bots' finished proposal calls to Bots, so its card shows (0.5.0)", () => {
    const proposal = {
      type: "tool_call", callId: "prop-1", name: "mcp__bots__propose_routine", status: "completed", error: null,
      detail: { type: "unknown", input: {}, output: "Proposal p-q1w2e3r4t5: the user sees the routine as a card in this chat." },
    } as unknown as Parameters<typeof transformToolCall>[0]["item"];
    expect(transformToolCall({ item: proposal, phase: "complete" })).toBeUndefined();
    expect(kindsOf(transformToolCall({ item: { ...proposal, status: "running" } as typeof proposal, phase: "streaming" }))).toEqual(["colorful-tool-call"]);
  });
});


describe("boundary refresh traffic", () => {
  it("pokes for a boundary first appearing and completing, never for intermediate streaming or re-projection", () => {
    const poke = vi.spyOn(foldRuntime, "poke");
    for (let index = 1; index <= 100; index++) observeBoundary({ item: { type: "assistant_message", messageId: "stream-test", text: "x".repeat(index) }, phase: "streaming" });
    expect(poke).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 100; index++) observeBoundary({ item: { type: "assistant_message", messageId: "stream-test", text: "complete" }, phase: "complete" });
    expect(poke).toHaveBeenCalledTimes(2);
    observeBoundary({ item: { type: "user_message", messageId: "next-boundary", text: "next" }, phase: "complete" });
    expect(poke).toHaveBeenCalledTimes(3);
    poke.mockRestore();
  });
});

describe("the Pi notice reader comes on demand (0.6.0-local.5)", () => {
  // Rows the 0.11.1 host builds from Pi extension messages (shared/pi-notice-rows.test.ts).
  const pi = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/pi-notices-0.11.1.json"), "utf8")) as {
    rows: Array<{ name: string; row: Record<string, unknown> }>;
  };
  const piRow = (callId: string, name = "bg-completed") => ({ ...pi.rows.find((entry) => entry.name === name)!.row, callId }) as unknown as Parameters<typeof transformToolCall>[0]["item"];
  type RowData = { status: string; pi?: { state: string; reader?: string; body?: string }; presentation: { label: string; summary?: string } };
  const dataOf = (result: ReturnType<typeof transformToolCall>) => result?.items[0]?.data as RowData | undefined;
  const flush = async () => {
    for (let step = 0; step < 8; step++) await Promise.resolve();
  };

  it("asks once for the reader when the first Pi notice row is drawn, then draws the rows again with it", async () => {
    let loads = 0;
    let redraws = 0;
    let deliver: (reader: PiNoticeReader) => void = () => undefined;
    configurePiNotices({ load: () => new Promise<PiNoticeReader>((resolve) => { loads += 1; deliver = resolve; }), redraw: () => void (redraws += 1) });
    try {
      // Until it is here the row is a neutral placeholder (no state mark), and drawing another asks no second time.
      expect(dataOf(transformToolCall({ item: piRow("pi-lazy-1"), phase: "complete" }))?.pi).toMatchObject({ state: "info", customType: "background-task-notification" });
      expect(dataOf(transformToolCall({ item: piRow("pi-lazy-2"), phase: "complete" }))?.pi).toMatchObject({ state: "info" });
      expect(loads).toBe(1);
      // A Claude Code row never asks.
      transformToolCall({ item: call("pi-lazy-bash", { type: "shell", command: "ls" }), phase: "complete" });
      expect(loads).toBe(1);
      deliver(readPiNotice);
      await flush();
      expect(redraws).toBe(1);
      // The cached transform of the same row is dropped: drawn again, it is the Chinese card.
      expect(dataOf(transformToolCall({ item: piRow("pi-lazy-1"), phase: "complete" }))?.pi).toMatchObject({ state: "done" });
      expect(loads).toBe(1);
    } finally {
      configurePiNotices(null);
      setPiNoticeReader(null);
    }
  });

  it("keeps real failed and killed notices neutral after the download fails, and tries again by itself and from 「重新读取」 (codex-vivid-merge-F2)", async () => {
    let loads = 0;
    let redraws = 0;
    let online = false;
    let nextTimer = 0;
    const timers = new Map<number, { run: () => void; ms: number }>();
    configurePiNotices({
      load: () => { loads += 1; return online ? Promise.resolve(readPiNotice) : Promise.reject(new Error("offline")); },
      redraw: () => void (redraws += 1),
      setTimer: (run, ms) => { timers.set(++nextTimer, { run, ms }); return nextTimer; },
      clearTimer: (timer) => void timers.delete(timer as number),
    });
    const fire = async () => {
      const [id, timer] = [...timers][0]!;
      timers.delete(id);
      timer.run();
      await flush();
    };
    try {
      const rows = [["pi-fail-1", "bg-failed"], ["pi-kill-1", "bg-killed"]] as const;
      for (const [callId, name] of rows) expect(dataOf(transformToolCall({ item: piRow(callId, name), phase: "complete" }))?.pi).toMatchObject({ state: "info", reader: "loading" });
      await flush();
      expect(redraws).toBe(1);
      // Drawn again after the reject: still not the host's completed, nor an ordinary tool row; the message as sent.
      for (const [callId, name] of rows) {
        const data = dataOf(transformToolCall({ item: piRow(callId, name), phase: "complete" }))!;
        expect(data.pi, name).toMatchObject({ state: "info", reader: "failed" });
        expect(data.pi!.body, name).toContain("<background-task-notification>");
        expect(data.presentation, name).toMatchObject({ label: "Pi 通知", summary: "没能读取，点开看原文" });
      }
      // It is tried again by itself, also on a page where no other Pi row is drawn; a Pi row drawn meanwhile asks nothing.
      expect([...timers.values()].map((timer) => timer.ms)).toEqual([30_000]);
      transformToolCall({ item: piRow("pi-fail-2", "bg-failed"), phase: "complete" });
      expect(loads).toBe(1);
      await fire();
      expect(loads).toBe(2);
      // Still offline: the rows stay as they are (no redraw), and the next try waits longer.
      expect(redraws).toBe(1);
      expect([...timers.values()].map((timer) => timer.ms)).toEqual([60_000]);
      // 「重新读取」: at once, the waiting retry dropped, the rows say 正在读取 meanwhile.
      online = true;
      retryPiNotices();
      expect(timers.size).toBe(0);
      expect(redraws).toBe(2);
      expect(dataOf(transformToolCall({ item: piRow("pi-fail-3", "bg-failed"), phase: "complete" }))?.pi).toMatchObject({ reader: "loading" });
      await flush();
      expect(loads).toBe(3);
      expect(redraws).toBe(3);
      expect(dataOf(transformToolCall({ item: piRow("pi-fail-1", "bg-failed"), phase: "complete" }))?.pi).toMatchObject({ state: "failed" });
      expect(dataOf(transformToolCall({ item: piRow("pi-kill-1", "bg-killed"), phase: "complete" }))?.pi).toMatchObject({ state: "stopped" });
      expect(dataOf(transformToolCall({ item: piRow("pi-fail-1", "bg-failed"), phase: "complete" }))?.status).toBe("failed");
    } finally {
      configurePiNotices(null);
      setPiNoticeReader(null);
    }
  });

  it("stops retrying when the plugin stops", async () => {
    const timers = new Map<number, () => void>();
    let loads = 0;
    configurePiNotices({
      load: () => { loads += 1; return Promise.reject(new Error("offline")); },
      redraw: () => undefined,
      setTimer: (run) => { timers.set(timers.size + 1, run); return timers.size; },
      clearTimer: (timer) => void timers.delete(timer as number),
    });
    transformToolCall({ item: piRow("pi-stop-1", "bg-failed"), phase: "complete" });
    await flush();
    expect(timers.size).toBe(1);
    configurePiNotices(null);
    expect(timers.size).toBe(0);
    expect(loads).toBe(1);
  });
});

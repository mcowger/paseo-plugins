import { describe, expect, it } from "vitest";
import { fileId } from "./changes";
import { reasoningKey } from "./fold";
import {
  claimsToolCall,
  exceedsTextBudget,
  foldIndexRpc,
  hostToolDisposition,
  indexRowFromWire,
  MAX_CLASSIFY_CHARS,
  textLines,
  toolLook,
  wirePageFromEntries,
  wireRowFromEntry,
} from "./fold-index";
import { TURN_TIME_RENDERER_KIND, TURN_TIME_RENDERER_VERSION } from "./turn-time";

const entry = (seqStart: number, item: Record<string, unknown>, provider = "claude", timestamp = "2026-10-09T10:00:00.000Z") => ({
  provider,
  item,
  timestamp,
  seqStart,
  seqEnd: seqStart,
  sourceSeqRanges: [],
  collapsed: [],
});
const call = (name: string, detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "tool_call",
  callId: `toolu_${name}`,
  name,
  status: "completed",
  error: null,
  detail,
  ...extra,
});
const at = Date.parse("2026-10-09T10:00:00.000Z");

describe("fold index rows", () => {
  it("reduces messages and cards to boundaries and keys reasoning by its text", () => {
    expect(wireRowFromEntry(entry(1, { type: "user_message", text: "hi" }))).toEqual({ s: 1, at, k: "b", w: "user_message" });
    expect(wireRowFromEntry(entry(2, { type: "reasoning", text: "先读文件" }))).toEqual({ s: 2, at, k: "r", key: reasoningKey("先读文件") });
    expect(wireRowFromEntry(entry(3, { type: "plugin", pluginId: "paseo-bots", kind: "proposal" }))).toMatchObject({ k: "b", w: "plugin" });
    expect(wireRowFromEntry(entry(4, { type: "todo", items: [] }))).toMatchObject({ k: "b", w: "todo" });
    expect(wireRowFromEntry({ item: { type: "assistant_message" } })).toBeNull();
    expect(wireRowFromEntry(entry(5, { type: "assistant_message", text: "x" }, "claude", "bogus"))).toMatchObject({ at: 0 });
  });

  it("leaves this plugin's turn-end time row out of the index, so it neither splits, joins nor times a run", () => {
    const marker = { type: "plugin", pluginId: "vivid-activity", kind: TURN_TIME_RENDERER_KIND, version: TURN_TIME_RENDERER_VERSION, data: { at, turnId: "t1", outcome: "completed" } };
    expect(wireRowFromEntry(entry(3, marker))).toBeNull();
    // Other plugin rows stay boundaries.
    expect(wireRowFromEntry(entry(3, { ...marker, kind: "vivid-other" }))).toMatchObject({ k: "b", w: "plugin" });
    // On a page it is no row, and the turn the host gives it adds no turn to the table.
    const turned = (seq: number, item: Record<string, unknown>, turnId: string) => ({ ...entry(seq, item), turnId });
    const { rows, turns } = wirePageFromEntries(
      [turned(1, call("Bash", { type: "shell", command: "a" }, { callId: "c1" }), "t2"), turned(2, marker, "t1"), turned(3, call("Bash", { type: "shell", command: "b" }, { callId: "c2" }), "t2")],
      () => null,
    );
    expect(rows.map((row) => row.s)).toEqual([1, 3]);
    expect(turns).toEqual([{ id: "t2", at: null }]);
  });

  it("keeps the tool look, status and call id, and leaves plans and spoken messages to Paseo", () => {
    expect(wireRowFromEntry(entry(6, call("Bash", { type: "shell", command: "npm test" }, { status: "failed" })))).toEqual({
      s: 6, at, k: "t", key: "t:toolu_Bash", st: "failed", look: "shell",
    });
    expect(wireRowFromEntry(entry(7, call("Read", { type: "read", filePath: "src/a.ts" })))).toMatchObject({ look: "read" });
    expect(wireRowFromEntry(entry(8, call("ExitPlanMode", { type: "plan", text: "## plan" })))).toMatchObject({ k: "b", w: "plan" });
    expect(wireRowFromEntry(entry(9, call("speak", { type: "unknown", input: "你好" })))).toMatchObject({ k: "b", w: "speak" });
    expect(claimsToolCall({ name: "speak", detail: { type: "unknown", input: "  " } })).toBe(true);
    // Paseo's agent messages (a child's report or finish notice) stay Paseo's rows and split segments like messages.
    const message = call("agent_message", { type: "plain_text", text: "Agent 子任务 finished.", icon: "bot" }, { callId: "paseo-agent-message:m1" });
    expect(wireRowFromEntry(entry(10, message))).toMatchObject({ k: "b", w: "agent-message" });
    expect(claimsToolCall(message)).toBe(false);
    expect(claimsToolCall({ ...message, callId: "toolu_agent_message" })).toBe(true);
    // Paseo 0.14 records a schedule or heartbeat prompt as a completed "heartbeat" call; the app starts a turn on it.
    const heartbeat = call("heartbeat", { type: "plain_text", text: 'Schedule "nightly" fired (id=s1, run=r1).\n检查构建', icon: "sparkles" }, { callId: "paseo-system:3f2a" });
    expect(wireRowFromEntry(entry(11, heartbeat))).toMatchObject({ k: "b", w: "heartbeat" });
    expect(claimsToolCall(heartbeat)).toBe(false);
    expect(claimsToolCall({ ...heartbeat, callId: "toolu_heartbeat" })).toBe(true);
  });

  it("mirrors how Paseo turns task-list tools into task rows or drops them", () => {
    const todos = { type: "unknown", input: { todos: [{ content: "补测试", status: "pending" }] } };
    expect(hostToolDisposition("claude", { name: "TodoWrite", detail: todos })).toBe("task");
    expect(hostToolDisposition("claude", { name: "TodoWrite", detail: { type: "unknown", input: {} } })).toBe("skip");
    expect(hostToolDisposition("codex", { name: "TodoWrite", detail: { type: "unknown", input: {} } })).toBeNull();
    expect(hostToolDisposition("claude", { name: "TaskUpdate", detail: { type: "unknown", input: {} } })).toBe("skip");
    expect(hostToolDisposition("codex", { name: "update_plan", detail: { type: "unknown", input: { plan: [{ step: "a", status: "pending" }] } } })).toBe("task");
    expect(hostToolDisposition("claude", { name: "Bash", detail: { type: "shell" } })).toBeNull();
    // Paseo compares the literal built-in id: a custom provider extending claude keeps these as ordinary tool rows.
    expect(hostToolDisposition("my-claude", { name: "TaskUpdate", detail: { type: "unknown", input: {} } })).toBeNull();
    expect(hostToolDisposition("my-claude", { name: "TodoWrite", detail: todos })).toBe("task");
    expect(wireRowFromEntry(entry(10, call("TodoWrite", todos)))).toMatchObject({ k: "b", w: "task" });
    expect(wireRowFromEntry(entry(11, call("TaskCreate", { type: "unknown", input: {} })))).toMatchObject({ k: "x" });
  });

  it("marks task notices: a foreground repeat of its command, or a background command", () => {
    const fg = call("task_notification", { type: "plain_text", label: "列出项目依赖", icon: "wrench" }, {
      callId: "task_notification_1",
      metadata: { synthetic: true, source: "claude_task_notification", toolUseId: "toolu_Bash" },
    });
    expect(wireRowFromEntry(entry(12, fg))).toEqual({ s: 12, at, k: "t", key: "t:task_notification_1", st: "completed", look: "shell", ref: "toolu_Bash", fg: true });
    const bg = { ...fg, detail: { type: "plain_text", label: 'Background command "构建" completed (exit code 0)' } };
    expect(wireRowFromEntry(entry(13, bg))).toMatchObject({ fg: false, ref: "toolu_Bash" });
    // 0.6.0-local.2: a repeat that brings the call's result is not folded away, on the server as on the client.
    const detached = { ...fg, detail: { type: "plain_text", label: "The Bash call finished; its result follows.", text: "<task-notification>\n<task-type>tool_call</task-type>\n<summary>The Bash call finished; its result follows.</summary>\n<result>\nok\n</result>\n</task-notification>" } };
    expect(wireRowFromEntry(entry(14, detached))).toMatchObject({ fg: false, ref: "toolu_Bash", st: "completed" });
    // A failed notice whose error quotes 「finished」 counts as a failure in the fold summary (codex-vivid-F2).
    const quoted = { ...fg, status: "failed", detail: { type: "plain_text", label: 'Agent "审查" failed: Hook "validate" finished with exit code 1' }, metadata: { synthetic: true, source: "claude_task_notification", toolUseId: "toolu_Agent", status: "failed" } };
    expect(wireRowFromEntry(entry(15, quoted))).toMatchObject({ st: "failed", look: "agent", fg: false });
  });

  describe("a repeat with a result of its own (0.6.0-local.3, 0.6.0-local.4)", () => {
    const notice = (id: string, result: string, callId = `task_notification_${id}`) =>
      call("task_notification", {
        type: "plain_text",
        label: "The Bash call finished; its result follows.",
        text: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<task-type>tool_call</task-type>\n<summary>The Bash call finished; its result follows.</summary>\n<result>\n${result.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</result>\n</task-notification>`,
      }, { callId, metadata: { synthetic: true, source: "claude_task_notification", toolUseId: id, status: "completed" } });
    const bash = (id: string, output: string) => call("Bash", { type: "shell", command: "npm run build", output }, { callId: id });
    const page = (...items: Array<Record<string, unknown>>) => wirePageFromEntries(items.map((item, index) => entry(index + 1, item)), () => null).rows;
    const placeholder = "[Still running. The user sent a message while this call loads, and that message follows so you can answer it now. This Bash call was not interrupted. Its result will be delivered to you on its own, in a later <task-notification> carrying this tool_use_id. Do not repeat the call, and do not wait, sleep or poll for it. You cannot stop it either, so never say you cancelled or dropped it. If they ask, it is still loading.]";

    it("folds into its row on the same page only when the row's final result reads the same", () => {
      // Both say `built in 4.2s` (colour codes and the line end aside): the notice folds into its row.
      expect(page(bash("same", "\u001b[32mbuilt in 4.2s\u001b[0m\r\n"), notice("same", "built in 4.2s"))[1]).toMatchObject({ ref: "same", fg: true });
      // More around it, a placeholder or another result: its own row; so too when the row is not on this page.
      expect(page(bash("more", "built in 4.2s\n2 warnings"), notice("more", "built in 4.2s"))[1]).toMatchObject({ fg: false });
      expect(page(bash("held", placeholder), notice("held", "built in 4.2s"))[1]).toMatchObject({ fg: false });
      expect(page(bash("other", "built in 3.9s"), notice("other", "built in 4.2s"))[1]).toMatchObject({ fg: false });
      expect(page(notice("elsewhere", "built in 4.2s"))[0]).toMatchObject({ fg: false });
      // A row still running has no final result yet.
      expect(page({ ...bash("live", "built in 4.2s"), status: "running" }, notice("live", "built in 4.2s"))[1]).toMatchObject({ fg: false });
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
        expect(page(bash(`m${index}`, output), notice(`m${index}`, result))[1], result.slice(0, 30)).toMatchObject({ ref: `m${index}`, fg: false });
      });
    });

    it("reads a row's result once per page, however many notices repeat it (codex-vivid-F7)", () => {
      // Codex: 400 notices of one 200 000-character output took 3 s, its result read again for each notice.
      const output = "\u001b[32mok\u001b[0m  \r\n".repeat(13_000);
      const notices = Array.from({ length: 400 }, (_, index) => notice("big", `ok ${index}`, `task_notification_big_${index}`));
      const started = performance.now();
      const rows = page(bash("big", output), ...notices);
      expect(performance.now() - started).toBeLessThan(250);
      expect(rows.filter((row) => row.ref === "big" && row.fg === false)).toHaveLength(400);
    });
  });

  describe("lines changed and exit codes (0.8.0)", () => {
    const cwd = "/home/user/demo-app";
    it("records an edit's +/− per file id and a failed command's exit code, never a path or a command", () => {
      const edit = call("Edit", { type: "edit", filePath: `${cwd}/src/a.ts`, oldString: "a\nb\n", newString: "a\nB\nc\n" });
      const row = wireRowFromEntry(entry(40, edit), undefined, cwd)!;
      expect(row).toMatchObject({ k: "t", look: "edit", ch: [[fileId("src/a.ts"), 2, 1]] });
      expect(JSON.stringify(row)).not.toContain("src/a.ts");
      expect(indexRowFromWire(row)).toMatchObject({ changes: [{ file: fileId("src/a.ts"), added: 2, removed: 1 }] });
      const codex = call("exec", { type: "shell", command: "npm test", exitCode: 3 }, { status: "failed" });
      expect(wireRowFromEntry(entry(41, codex), undefined, cwd)).toMatchObject({ st: "failed", look: "shell", x: 3 });
      const claude = call("Bash", { type: "shell", command: "npm run lint" }, { status: "failed", error: { type: "tool_result", content: "Exit code 1\nlint failed", is_error: true } });
      const failed = wireRowFromEntry(entry(42, claude), undefined, cwd)!;
      expect(failed).toMatchObject({ x: 1 });
      expect(JSON.stringify(failed)).not.toContain("npm run lint");
      expect(indexRowFromWire(failed)).toMatchObject({ exit: 1 });
    });

    it("marks writes as changes without line counts, and leaves out unfinished edits and commands that did not fail", () => {
      const write = wireRowFromEntry(entry(43, call("Write", { type: "write", filePath: "a.md", content: "x" })), undefined, cwd)!;
      expect(write).not.toHaveProperty("ch");
      expect(write).toMatchObject({ nc: 1 });
      expect(indexRowFromWire(write)).toMatchObject({ uncounted: 1 });
      expect(wireRowFromEntry(entry(44, call("Edit", { type: "edit", filePath: "a.md", oldString: "a", newString: "b" }, { status: "running" })), undefined, cwd)).not.toHaveProperty("ch");
      expect(wireRowFromEntry(entry(45, call("Bash", { type: "shell", command: "ls", exitCode: 0 })), undefined, cwd)).not.toHaveProperty("x");
    });

    it("counts each file of an apply_patch call, and a call Paseo kept only one file of as a change without line counts", () => {
      const patch = "*** Begin Patch\n*** Add File: docs/a.md\n+# a\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** Delete File: src/c.ts\n*** End Patch";
      const whole = wireRowFromEntry(entry(46, call("apply_patch", { type: "unknown", input: { patch }, output: null })), undefined, cwd)!;
      expect(whole).toMatchObject({ look: "edit", ch: [[fileId("docs/a.md"), 1, 0], [fileId("src/b.ts"), 1, 1]], nc: 1 });
      const firstOnly = wireRowFromEntry(entry(47, call("apply_patch", { type: "edit", filePath: "src/config.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" })), undefined, cwd)!;
      expect(firstOnly).not.toHaveProperty("ch");
      expect(firstOnly).toMatchObject({ look: "edit", nc: 1 });
    });

    it("passes the Agent's directory through a page", () => {
      const edit = call("Edit", { type: "edit", filePath: `${cwd}/src/a.ts`, oldString: "a", newString: "b" });
      expect(wirePageFromEntries([entry(1, edit)], () => null, cwd).rows[0]).toMatchObject({ ch: [[fileId("src/a.ts"), 1, 1]] });
    });

    it("accepts the new fields and the turns' tokens in the RPC contract", () => {
      const output = {
        status: "ok", epoch: "e", rows: [{ s: 1, at: 0, k: "t", key: "t:a", st: "completed", look: "edit", ch: [["abc", 1, 2]] }, { s: 2, at: 0, k: "t", key: "t:b", st: "failed", look: "shell", x: 127 }],
        startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, reset: false, running: false,
        tok: [{ id: "foreground-turn-1", i: 10, c: null, o: 5 }, { id: "codex-turn-2", i: 1, c: 2, o: 3, live: true }],
      };
      expect(foldIndexRpc.output.parse(output)).toMatchObject({ tok: [{ id: "foreground-turn-1", c: null }, { live: true }] });
      expect(() => foldIndexRpc.output.parse({ ...output, rows: [{ s: 1, at: 0, k: "t", ch: [] }] })).toThrow();
      expect(foldIndexRpc.output.parse({ ...output, rows: [{ s: 1, at: 0, k: "t", nc: 2 }] }).rows[0]).toMatchObject({ nc: 2 });
      expect(() => foldIndexRpc.output.parse({ ...output, rows: [{ s: 1, at: 0, k: "t", nc: 0 }] })).toThrow();
      expect(() => foldIndexRpc.output.parse({ ...output, tok: [{ id: "x", i: -1, c: 0, o: 0 }] })).toThrow();
    });
  });

  it("draws apply_patch as edits", () => {
    const patch = "*** Begin Patch\n*** Add File: docs/a.md\n+# a\n*** End Patch";
    expect(toolLook({ name: "apply_patch", detail: { type: "unknown", input: { patch }, output: null } } as never)).toBe("write");
  });

  it("counts a tool call too big to classify as other, without parsing it (0.4.1)", () => {
    const over = "x".repeat(MAX_CLASSIFY_CHARS);
    const mcp = (input: unknown) => call("mcp__github__search_code", { type: "unknown", input, output: null });
    const small = wireRowFromEntry(entry(30, mcp(JSON.stringify({ query: "TODO" }))));
    expect(small).toMatchObject({ k: "t", key: "t:toolu_mcp__github__search_code" });
    expect(small?.look).not.toBe("other");
    expect(wireRowFromEntry(entry(31, mcp(JSON.stringify({ query: over }))))).toMatchObject({ k: "t", key: "t:toolu_mcp__github__search_code", look: "other" });
    // Text in the output and in the metadata counts too.
    expect(wireRowFromEntry(entry(32, call("Bash", { type: "shell", command: "ls", output: over })))).toMatchObject({ look: "other" });
    expect(wireRowFromEntry(entry(33, call("Bash", { type: "shell", command: "ls" }, { metadata: { log: over } })))).toMatchObject({ look: "other" });
    // Ordinary large calls are far below it: a 300 000-character read stays a read.
    expect(wireRowFromEntry(entry(34, call("Read", { type: "read", filePath: "src/big.ts", content: "y".repeat(300_000) })))).toMatchObject({ look: "read" });
    // Task rows and dropped rows are still told apart however big the call is.
    expect(wireRowFromEntry(entry(35, call("TaskCreate", { type: "unknown", input: { subject: over } })))).toMatchObject({ k: "x" });
  });

  it("measures text with a budget and stops as soon as it is spent", () => {
    expect(exceedsTextBudget("abc", 4)).toBe(false);
    expect(exceedsTextBudget("abc", 3)).toBe(true);
    expect(exceedsTextBudget({ a: [1, null, "xy"] }, 10)).toBe(false);
    expect(exceedsTextBudget({ a: [1, null, "xy"] }, 6)).toBe(true);
    expect(exceedsTextBudget(undefined, 0)).toBe(true);
    const values = Array.from({ length: 2_000_000 }, () => 0);
    const started = performance.now();
    expect(exceedsTextBudget(values, 1_000)).toBe(true);
    expect(exceedsTextBudget({ huge: "z".repeat(10_000_000) }, 1_000)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("keeps seqEnd only when the entry was updated after it began", () => {
    expect(wireRowFromEntry({ ...entry(20, call("Bash", { type: "shell", command: "ls" })), seqEnd: 23 })).toMatchObject({ s: 20, e: 23 });
    expect(indexRowFromWire({ s: 20, e: 23, at: 1, k: "b", w: "x" })).toMatchObject({ seq: 20, seqEnd: 23 });
    expect(indexRowFromWire({ s: 20, at: 1, k: "b", w: "x" }).seqEnd).toBeUndefined();
  });

  it("tells each row's turn through a small table, with the starts the server knows", () => {
    const turned = (seq: number, item: Record<string, unknown>, turnId?: string) => ({ ...entry(seq, item), ...(turnId ? { turnId } : {}) });
    const { rows, turns } = wirePageFromEntries(
      [
        turned(1, { type: "user_message", text: "hi" }, "foreground-turn-1"),
        turned(2, { type: "reasoning", text: "a" }, "foreground-turn-1"),
        turned(3, { type: "reasoning", text: "b" }, "autonomous-turn-2"),
        turned(4, { type: "assistant_message", text: "c" }),
        { bogus: true },
      ],
      (turnId) => (turnId === "autonomous-turn-2" ? 5_000 : null),
    );
    expect(turns).toEqual([{ id: "foreground-turn-1", at: null }, { id: "autonomous-turn-2", at: 5_000 }]);
    expect(rows.map((row) => row.u)).toEqual([0, 0, 1, undefined]);
    expect(rows.map((row) => indexRowFromWire(row, turns).turn)).toEqual(["foreground-turn-1", "foreground-turn-1", "autonomous-turn-2", undefined]);
    const parsed = foldIndexRpc.output.parse({ status: "missing", epoch: "", rows: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, reset: false, running: null, turns, active: { id: "autonomous-turn-2", at: null } });
    expect(parsed.active).toEqual({ id: "autonomous-turn-2", at: null });
  });

  it("round-trips through the RPC schema", () => {
    const rows = [
      wireRowFromEntry(entry(1, { type: "user_message", text: "hi" }))!,
      wireRowFromEntry(entry(2, call("Bash", { type: "shell", command: "ls" })))!,
    ];
    const parsed = foldIndexRpc.output.parse({ status: "ok", epoch: "e1", rows, startCursor: { epoch: "e1", seq: 1 }, endCursor: { epoch: "e1", seq: 3 }, hasOlder: false, hasNewer: false, reset: false, running: true });
    expect(parsed.rows.map((row) => indexRowFromWire(row))).toEqual([
      { seq: 1, at, kind: "boundary", what: "user_message" },
      { seq: 2, at, kind: "tool", key: "t:toolu_Bash", status: "completed", look: "shell" },
    ]);
    expect(indexRowFromWire({ s: 3, at: 0, k: "t", key: "t:n", st: "completed", look: "shell", ref: "r", fg: true }).notice).toEqual({ ref: "r", foreground: true });
    expect(indexRowFromWire({ s: 4, at: 0, k: "x", w: "hidden-tool" }).kind).toBe("skip");
  });
});

describe("how long an Agent's text is (0.6.0, for the pinned question)", () => {
  it("sends about how many lines each Agent text takes, and nothing more of it", () => {
    const row = wireRowFromEntry(entry(4, { type: "assistant_message", text: `先看入口。\n${"很长的一句说明".repeat(12)}\n\n好了。` }));
    expect(row).toEqual({ s: 4, at, k: "b", w: "assistant_message", ln: 6 });
    expect(foldIndexRpc.output.shape.rows.element.safeParse(row).success).toBe(true);
    expect(indexRowFromWire(row!)).toEqual({ seq: 4, at, kind: "boundary", what: "assistant_message", lines: 6 });
    // User messages and other boundaries carry no length.
    expect(wireRowFromEntry(entry(5, { type: "user_message", text: "很长的问题".repeat(40) }))).toEqual({ s: 5, at, k: "b", w: "user_message" });
  });

  it("counts 40 characters a line and every line break, and stops at 999 lines without reading the rest", () => {
    expect(textLines("")).toBe(1);
    expect(textLines("a".repeat(40))).toBe(1);
    expect(textLines("a".repeat(41))).toBe(2);
    expect(textLines("一\n二\n三")).toBe(3);
    expect(textLines("x\n")).toBe(2);
    const started = performance.now();
    expect(textLines("line\n".repeat(2_000_000))).toBe(999);
    expect(textLines("a".repeat(5_000_000))).toBe(999);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

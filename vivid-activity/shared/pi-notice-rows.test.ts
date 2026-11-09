import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { indexRowFromWire, wireRowFromEntry } from "./fold-index";
import { piNoticeStatus, readPiNotice } from "./pi-notice";
import { createToolCallData, hasPiNoticeReader, PI_NOTICE_BODY_CHARS, setPiNoticePhase, setPiNoticeReader, toolCallItemDataSchema } from "./timeline";

type ToolItem = Extract<AgentTimelineItem, { type: "tool_call" }>;
const here = path.dirname(fileURLToPath(import.meta.url));
// Rows built by the 0.11.1 host's own mapCustomMessageToToolCall (see shared/pi-notice.test.ts).
const fixtures = JSON.parse(readFileSync(path.resolve(here, "../test-fixtures/pi-notices-0.11.1.json"), "utf8")) as { rows: Array<{ name: string; row: ToolItem }> };
const row = (name: string): ToolItem => structuredClone(fixtures.rows.find((entry) => entry.name === name)!.row);

describe("Pi extension notices before their reader is loaded (0.6.0-local.5)", () => {
  // Paseo 0.11.1 marks every Pi custom message completed: without the reader nothing may show that as the notice's state.
  const failedTasks = ["bg-failed", "bg-killed", "notify-failed", "web-error"];
  const bash = { type: "tool_call", callId: "pi-wait-bash", name: "Bash", status: "completed", detail: { type: "shell", command: "ls" } } as unknown as ToolItem;
  const raw = (item: ToolItem) => (item.detail as { text: string }).text;
  afterEach(() => setPiNoticePhase("idle"));

  it("draws a neutral row while the reader is on its way: no message type, no XML, no state mark", () => {
    expect(hasPiNoticeReader()).toBe(false);
    setPiNoticePhase("loading");
    for (const name of ["bg-completed", ...failedTasks]) {
      const item = row(name);
      const data = toolCallItemDataSchema.parse(createToolCallData(item));
      expect(data.pi, name).toEqual({ customType: item.name, state: "info", look: "other", fields: [{ label: "说明", value: "正在读取这条通知…" }], reader: "loading" });
      expect(data.presentation, name).toEqual({ category: "unknown", icon: "Bell", label: "Pi 通知", summary: "正在读取…" });
      expect(data.detail, name).toEqual(item.detail);
    }
    // Any other tool row is drawn as usual meanwhile.
    expect(createToolCallData(bash).pi).toBeUndefined();
    expect(createToolCallData(bash).presentation.label).not.toBe("Pi 通知");
  });

  it("keeps a failed or killed task neutral after the download failed, says so, and keeps the message as sent (codex-vivid-merge-F2)", () => {
    setPiNoticePhase("failed");
    for (const name of failedTasks) {
      const item = row(name);
      const data = toolCallItemDataSchema.parse(createToolCallData(item));
      // Not an ordinary tool row, which would take the host's completed (green 「完成」).
      expect(data.pi, name).toMatchObject({ customType: item.name, state: "info", look: "other", reader: "failed", body: raw(item) });
      expect(data.pi!.fields[0]!.value, name).toContain("没有下载成功");
      expect(data.presentation, name).toEqual({ category: "unknown", icon: "Bell", label: "Pi 通知", summary: "没能读取，点开看原文" });
    }
    expect(createToolCallData(bash).pi).toBeUndefined();
  });

  it("says when nobody asked for the reader (no loader), with the message as sent", () => {
    const item = row("bg-killed");
    const data = toolCallItemDataSchema.parse(createToolCallData(item));
    expect(data.pi).toMatchObject({ state: "info", reader: "idle", body: raw(item) });
    expect(data.presentation.summary).toBe("还没读取，点开看原文");
  });

  it("keeps the row data bounded when the message is very long", () => {
    setPiNoticePhase("failed");
    const item = row("bg-failed");
    (item.detail as { text: string }).text = "x".repeat(PI_NOTICE_BODY_CHARS + 50);
    const data = createToolCallData(item);
    expect(data.pi?.body).toHaveLength(PI_NOTICE_BODY_CHARS);
    expect(data.pi?.cut).toBe(true);
  });

  it("is the Chinese card with its own state once the reader is here", () => {
    setPiNoticePhase("failed");
    setPiNoticeReader(readPiNotice);
    try {
      expect(createToolCallData(row("bg-failed")).pi).toMatchObject({ customType: "background-task-notification", state: "failed" });
      expect(createToolCallData(row("bg-killed")).pi).toMatchObject({ customType: "background-task-notification", state: "stopped" });
      expect(createToolCallData(row("bg-failed")).pi?.reader).toBeUndefined();
    } finally {
      setPiNoticeReader(null);
    }
  });
});

describe("Pi extension notices in the timeline (opus-B30)", () => {
  // The reader ships in its own lazy chunk (0.6.0-local.5); client/transform.ts installs it when the chunk arrives.
  beforeAll(() => setPiNoticeReader(readPiNotice));
  afterAll(() => setPiNoticeReader(null));

  it("turns every notice into a Chinese row with its state, and leaves the raw message in the detail", () => {
    let read = 0;
    for (const { name, row: item } of fixtures.rows) {
      const notice = readPiNotice(item);
      const data = toolCallItemDataSchema.parse(createToolCallData(item));
      if (!notice) {
        expect(data.pi, name).toBeUndefined();
        continue;
      }
      read += 1;
      expect(data.pi, name).toMatchObject({ customType: notice.customType, state: notice.state, look: notice.look });
      expect(data.presentation.label, name).toBe(notice.title);
      expect(data.presentation.summary, name).toBe(notice.summary);
      expect(data.status, name).toBe(piNoticeStatus(notice.state));
      expect(data.detail, name).toEqual(item.detail);
      // Paseo 0.11.1 refuses plugin row data over 64 KB on the server side; these stay far below it.
      expect(Buffer.byteLength(JSON.stringify(data)), name).toBeLessThan(16 * 1024);
    }
    expect(read).toBeGreaterThanOrEqual(fixtures.rows.length - 1);
  });

  it("reads the states the way they are meant: failed red, killed and paused stopped, reports and reminders finished", () => {
    const status = (name: string) => createToolCallData(row(name)).status;
    expect(status("bg-completed")).toBe("completed");
    expect(status("bg-failed")).toBe("failed");
    expect(status("bg-killed")).toBe("canceled");
    expect(status("notify-failed")).toBe("failed");
    expect(status("notify-paused-foreground")).toBe("canceled");
    expect(status("gotgenes-update")).toBe("completed");
    expect(status("supervisor-request")).toBe("completed");
    expect(createToolCallData(row("bg-completed")).presentation).toMatchObject({ category: "shell", icon: "SquareTerminal", label: "后台任务" });
    expect(createToolCallData(row("web-results")).presentation).toMatchObject({ category: "search", icon: "Globe", label: "联网搜索" });
    expect(createToolCallData(row("goal-budget")).presentation).toMatchObject({ category: "plan", icon: "Target", label: "目标" });
    expect(createToolCallData(row("unknown-xml")).presentation).toMatchObject({ category: "unknown", icon: "Bell", label: "Pi 通知" });
  });

  it("counts a notice in fold summaries with its look and how it ended", () => {
    const wire = (name: string) => indexRowFromWire(wireRowFromEntry({ provider: "pi", seqStart: 4, timestamp: "2026-10-12T00:00:00.000Z", item: row(name) })!);
    expect(wire("bg-failed")).toMatchObject({ kind: "tool", status: "failed", look: "shell" });
    expect(wire("notify-grouped")).toMatchObject({ kind: "tool", look: "agent" });
    expect(wire("web-error")).toMatchObject({ status: "failed", look: "web" });
    expect(wire("bg-killed")).toMatchObject({ status: "canceled" });
    expect(wire("watchdog-blocker")).toMatchObject({ status: "completed", look: "agent" });
  });

  it("keeps a huge notice within bounds", () => {
    // A long error output in the details: each field holds at most 2 000 characters.
    const failed = row("bg-failed");
    const metadata = failed.metadata as { details?: Record<string, unknown> };
    metadata.details = { ...metadata.details, error: "e".repeat(PI_NOTICE_BODY_CHARS * 3) };
    const fields = createToolCallData(failed).pi!.fields;
    expect(fields.find((field) => field.label === "错误")!.value).toHaveLength(2_000);
    // A long message of an unknown type: the body holds at most PI_NOTICE_BODY_CHARS characters and says it was cut.
    const unknown = row("unknown-xml");
    unknown.detail = { type: "plain_text", text: `部署进度\n${"日志行\n".repeat(PI_NOTICE_BODY_CHARS)}` };
    const data = createToolCallData(unknown);
    expect(data.pi!.body!.length).toBe(PI_NOTICE_BODY_CHARS);
    expect(data.pi!.cut).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ ...data, detail: null }))).toBeLessThan(64 * 1024);
  });
});

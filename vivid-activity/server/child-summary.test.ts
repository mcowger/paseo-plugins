import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { childSummaryRpc } from "../shared/child-summary";
import { childSummaryRow, handleChildSummary } from "./child-summary";
import { hostRoute } from "./host-routes";

// fetch_agent records Paseo 0.11.1 itself builds: live (loaded, with `activeTurn`) and stored (not loaded).
const records = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/child-records-0.11.1.json"), "utf8")) as Record<string, Record<string, unknown>>;

/** A child whose record is live (loaded) unless `stored`; `fail` makes the status check throw. */
function fake(status: string | null = "running", archivedAt: string | null = null, options: { stored?: boolean; fail?: string } = {}) {
  const calls: unknown[] = [];
  const context = { paseo: { agents: { ref: (agentId: string) => {
    calls.push(agentId);
    return {
      refresh: async () => {
        if (options.fail) throw new Error(options.fail);
        return { agent: status ? { status, archivedAt, ...(options.stored ? {} : { activeTurn: null }) } : null };
      },
      timeline: { refetch: async (input: unknown) => {
        calls.push(input);
        return { agent: { status: "running" }, entries: Array.from({ length: 8 }, (_, n) => ({ seqStart: n, seqEnd: n, item: { type: "assistant_message", text: "运行中的摘要与较长输出 😀 ".repeat(2000) } })) };
      } },
    };
  } } } } as unknown as PluginHandlerContext;
  return { context, calls };
}

describe("compact child summaries", () => {
  it("says when a child waits for you or failed, with common tokens masked (0.10)", async () => {
    const context = (agent: Record<string, unknown>) => ({ paseo: { agents: { ref: () => ({
      refresh: async () => ({ agent: { activeTurn: null, ...agent } }),
      timeline: { refetch: async () => ({ entries: [] }) },
    }) } } }) as unknown as PluginHandlerContext;
    const approval = await handleChildSummary({ agentId: "c", statusOnly: true }, context({ status: "running", pendingPermissions: [{ id: "1", kind: "tool" }, { id: "2", kind: "question" }] }));
    expect(approval.agent).toEqual({ status: "running", waiting: "approval" });
    const question = await handleChildSummary({ agentId: "c", statusOnly: true }, context({ status: "running", pendingPermissions: [{ id: "1", kind: "question" }] }));
    expect(question.agent?.waiting).toBe("question");
    expect((await handleChildSummary({ agentId: "c", statusOnly: true }, context({ status: "running", pendingPermissions: [] }))).agent).toEqual({ status: "running" });
    // Built at runtime: a literal token-shaped string would trip secret scanners on the published source.
    const token = `${"sk"}-${"a1".repeat(12)}`;
    const failed = await handleChildSummary({ agentId: "c", manual: true }, context({ status: "error", lastError: `401 Unauthorized ${token}\n    at fetch (x.js:1:1)` }));
    expect(failed.agent?.error).toBe("401 Unauthorized [redacted]");
    expect(childSummaryRpc.output.parse(failed)).toEqual(failed);
  });

  it("returns only the three newest previews, with UTF-8 byte caps instead of full output or agent records", async () => {
    const { context, calls } = fake();
    const output = await handleChildSummary({ agentId: "child" }, context);
    expect(childSummaryRpc.output.parse(output)).toEqual(output);
    expect(output.rows.map((row) => row.k)).toEqual(["5", "6", "7"]);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(550);
    for (const row of output.rows) expect(Buffer.byteLength(row.x!)).toBeLessThanOrEqual(72);
    expect(calls).toEqual(["child", { direction: "tail", limit: 8, projection: "projected" }]);
  });

  it("never gives one of the three places to this plugin's turn-end time row", async () => {
    const command = (n: number) => ({ seqStart: n, seqEnd: n, item: { type: "tool_call", callId: `t-${n}`, name: "Bash", status: "completed", detail: { type: "shell", command: `echo ${n}` } } });
    const marker = { seqStart: 4, seqEnd: 4, item: { type: "plugin", pluginId: "vivid-activity", kind: "vivid-turn-time", version: 1, data: { at: 1, turnId: "t1", outcome: "completed" } } };
    const card = { seqStart: 5, seqEnd: 5, item: { ...marker.item, kind: "other-card" } };
    const context = (entries: unknown[]) => ({ paseo: { agents: { ref: () => ({
      refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
      timeline: { refetch: async () => ({ entries }) },
    }) } } }) as unknown as PluginHandlerContext;
    const output = await handleChildSummary({ agentId: "child", manual: true }, context([command(1), command(2), command(3), marker]));
    expect(output.rows.map((row) => row.k)).toEqual(["1", "2", "3"]);
    // Another plugin's row is still part of what the child shows.
    const other = await handleChildSummary({ agentId: "child", manual: true }, context([command(1), command(2), command(3), marker, card]));
    expect(other.rows.map((row) => [row.k, row.t])).toEqual([["2", expect.any(String)], ["3", expect.any(String)], ["5", "other-card"]]);
  });

  it("caps a response containing three long tool summaries as a whole", async () => {
    const context = { paseo: { agents: { ref: () => ({
      refresh: async () => ({ agent: { status: "running", activeTurn: null } }),
      timeline: { refetch: async () => ({ entries: Array.from({ length: 3 }, (_, n) => ({
        seqStart: Number.MAX_SAFE_INTEGER - n, seqEnd: Number.MAX_SAFE_INTEGER,
        item: { type: "tool_call", callId: `long-${n}`, name: "Bash", status: "running", detail: { type: "shell", command: "命令和工具参数😀".repeat(100), output: "x".repeat(100_000) } },
      })) }) },
    }) } } } as unknown as PluginHandlerContext;
    const output = await handleChildSummary({ agentId: "child" }, context);
    expect(output.rows).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(500);
    expect(output.rows.every((row) => row.s === "running" && row.i && row.t)).toBe(true);
  });

  it("a failed child's long error line doesn't take the rows' room", async () => {
    const context = (lastError: string | null) => ({ paseo: { agents: { ref: () => ({
      refresh: async () => ({ agent: { status: lastError ? "error" : "running", activeTurn: null, lastError } }),
      timeline: { refetch: async () => ({ entries: Array.from({ length: 3 }, (_, n) => ({ seqStart: n, seqEnd: n,
        item: { type: "tool_call", callId: `t-${n}`, name: "Bash", status: "completed", detail: { type: "shell", command: `npm run build:${n}`, output: "构建输出".repeat(40) } } })) }) },
    }) } } }) as unknown as PluginHandlerContext;
    const plain = await handleChildSummary({ agentId: "child", manual: true }, context(null));
    const failed = await handleChildSummary({ agentId: "child", manual: true }, context("构建失败：找不到模块，请检查依赖是否安装完整".repeat(5)));
    expect(failed.agent?.error).toBeTruthy();
    expect(failed.rows).toEqual(plain.rows);
  });

  it("does not load closed, archived, missing or provider children automatically", async () => {
    for (const [status, archive] of [["closed", null], ["running", "2026-01-01"], [null, null]] as const) {
      const { context, calls } = fake(status, archive);
      const output = await handleChildSummary({ agentId: "child" }, context);
      expect(output.status).toBe(status === null ? "missing" : "closed");
      expect(calls).toEqual(["child"]);
    }
    const { context, calls } = fake();
    expect((await handleChildSummary({ agentId: "provider:parent:child", manual: true }, context)).status).toBe("missing");
    expect(calls).toEqual([]);
  });

  it("reads only a child whose record shows it loaded, whatever status a stored record kept (0.6.0, codex-F18)", async () => {
    // A daemon that went down leaves its Agents stored as running or idle: those are not loaded, and reading would load them.
    for (const name of ["storedRunning", "storedIdle", "storedClosed"]) {
      const record = records[name]!;
      const { context, calls } = fake(record.status as string, null, { stored: true });
      const output = await handleChildSummary({ agentId: "child" }, context);
      expect(output, name).toMatchObject({ status: "closed", agent: { status: "closed" }, rows: [] });
      expect(calls, name).toEqual(["child"]);
      expect((await handleChildSummary({ agentId: "child", statusOnly: true }, fake(record.status as string, null, { stored: true }).context)).agent, name).toEqual({ status: "closed" });
    }
    for (const name of ["liveRunning", "liveIdle"]) {
      const record = records[name]!;
      expect("activeTurn" in record).toBe(true);
      const { context, calls } = fake(record.status as string);
      expect((await handleChildSummary({ agentId: "child" }, context)).status, name).toBe("ok");
      expect(calls, name).toHaveLength(2);
    }
  });

  it("reads nothing by itself when the status check fails, and says so; the user's own read still goes ahead (0.6.0, grok-F9, pi-F2)", async () => {
    const failing = fake("running", null, { fail: "socket closed" });
    expect(await handleChildSummary({ agentId: "child" }, failing.context)).toEqual({ status: "unconfirmed", agent: null, rows: [] });
    expect(await handleChildSummary({ agentId: "child", statusOnly: true }, failing.context)).toEqual({ status: "unconfirmed", agent: null, rows: [] });
    expect(failing.calls).toEqual(["child", "child"]);
    const asked = fake("running", null, { fail: "socket closed" });
    expect((await handleChildSummary({ agentId: "child", manual: true }, asked.context)).rows).toHaveLength(3);
    expect(asked.calls).toHaveLength(2);
    // An Agent the daemon does not know is gone, not unconfirmed.
    expect((await handleChildSummary({ agentId: "child" }, fake("running", null, { fail: "Agent not found" }).context)).status).toBe("missing");
  });

  it("keeps the existing explicit read of a closed child and supports status-only checks", async () => {
    const closed = fake("closed");
    expect((await handleChildSummary({ agentId: "child", manual: true }, closed.context)).rows).toHaveLength(3);
    expect(closed.calls).toHaveLength(2);
    const active = fake();
    expect((await handleChildSummary({ agentId: "child", statusOnly: true }, active.context)).rows).toEqual([]);
    expect(active.calls).toHaveLength(1);
  });

  it("preserves the presentation for tools, tasks and notices without sending their bodies", () => {
    const items: AgentTimelineItem[] = [
      { type: "tool_call", callId: "a", name: "Bash", status: "running", detail: { type: "shell", command: "ls src", output: "x".repeat(20_000) } },
      { type: "todo", items: [{ text: "one", completed: true }] },
      { type: "error", message: "problem" },
      { type: "notification", level: "error", message: "failed" },
    ] as AgentTimelineItem[];
    const rows = items.map((item, n) => childSummaryRow({ seqStart: n, seqEnd: n, item }));
    for (const row of rows) expect(childSummaryRpc.output.shape.rows.element.safeParse(row).success).toBe(true);
    expect(rows[0]).toMatchObject({ s: "running", c: "shell" });
    expect(rows[1]).toMatchObject({ t: "任务", x: "已完成 1/1 项" });
    expect(rows[2]).toMatchObject({ c: "failed" });
    expect(rows[3]).toMatchObject({ c: "failed" });
    expect(JSON.stringify(rows)).not.toContain("x".repeat(100));
  });
});

describe("a child on another host (Paseo 0.13 connected hosts, 0.9.1)", () => {
  /** A daemon on `self` that reaches the hosts listed; `client` lends `remote`'s API (and counts lends and disposals). */
  function connected(remote: PluginHandlerContext["paseo"], options: { listed?: Array<{ serverId: string; label: string | null }>; connect?: () => Promise<void>; local?: PluginHandlerContext["paseo"] } = {}) {
    const log = { lends: 0, disposed: 0, lists: 0 };
    const local = options.local ?? fake("idle").context.paseo;
    const paseo = Object.assign(Object.create(null), local, { hosts: {
      list: async () => { log.lists++; return { self: { serverId: "srv_linux" }, hosts: options.listed ?? [{ serverId: "srv_mac", label: "MacBook" }] }; },
      client: async () => { log.lends++; await options.connect?.(); return Object.assign(Object.create(null), remote, { dispose: async () => { log.disposed++; } }); },
    } });
    return { context: { paseo } as unknown as PluginHandlerContext, log };
  }

  it("reads the child where it runs, by the same rules, and names that host; the borrowed API serves later reads", async () => {
    const there = fake("running");
    const { context, log } = connected(there.context.paseo);
    const output = await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, context);
    expect(childSummaryRpc.output.parse(output)).toEqual(output);
    expect(output).toMatchObject({ status: "ok", host: "MacBook" });
    expect(output.rows).toHaveLength(3);
    expect(there.calls).toEqual(["child", { direction: "tail", limit: 8, projection: "projected" }]);
    await handleChildSummary({ agentId: "child", serverId: "srv_mac", statusOnly: true }, context);
    expect(log).toMatchObject({ lends: 1, disposed: 0 });
    // Closed or stored there: nothing is read by itself, as here.
    const closed = connected(fake("closed").context.paseo);
    expect(await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, closed.context)).toEqual({ status: "closed", agent: { status: "closed" }, rows: [], host: "MacBook" });
  });

  it("reads here a child named by this host's own id, or on a daemon without connected hosts", async () => {
    const here = fake("running");
    const { context, log } = connected(fake("running").context.paseo, { local: here.context.paseo });
    const output = await handleChildSummary({ agentId: "child", serverId: "srv_linux" }, context);
    expect(output.host).toBeUndefined();
    expect(here.calls[0]).toBe("child");
    expect(log.lends).toBe(0);
    const older = fake("running");
    expect((await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, older.context)).status).toBe("ok");
    expect(older.calls[0]).toBe("child");
  });

  it("says a host this daemon does not reach, or cannot reach now, is offline, and connects again on the next read", async () => {
    const unknown = connected(fake("running").context.paseo, { listed: [] });
    expect(await handleChildSummary({ agentId: "child", serverId: "srv_far" }, unknown.context)).toEqual({ status: "offline", agent: null, rows: [], host: "srv_far" });
    expect(unknown.log.lends).toBe(0);
    let fail = true;
    const flaky = connected(fake("running").context.paseo, { connect: async () => { if (fail) throw Object.assign(new Error("Host srv_mac is offline"), { code: "host_offline" }); } });
    expect(await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, flaky.context)).toMatchObject({ status: "offline", host: "MacBook" });
    fail = false;
    expect(await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, flaky.context)).toMatchObject({ status: "ok", host: "MacBook" });
    expect(flaky.log.lends).toBe(2);
  });

  it("lets a route that broke go, so the next read connects again", async () => {
    const lost = connected(fake("running", null, { fail: "route closed" }).context.paseo);
    expect(await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, lost.context)).toEqual({ status: "offline", agent: null, rows: [], host: "MacBook" });
    await Promise.resolve();
    expect(lost.log).toMatchObject({ lends: 1, disposed: 1 });
    await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, lost.context);
    expect(lost.log.lends).toBe(2);
    // A child its host no longer has is missing there, and the route stays.
    const gone = connected(fake(null).context.paseo);
    expect(await handleChildSummary({ agentId: "child", serverId: "srv_mac" }, gone.context)).toEqual({ status: "missing", agent: null, rows: [], host: "MacBook" });
    expect(gone.log.disposed).toBe(0);
  });
});

describe("borrowed host APIs (host-routes.ts)", () => {
  it("gives a borrowed API back after a minute without reads, and keeps it while reads go on", async () => {
    vi.useFakeTimers();
    try {
      let disposed = 0, lends = 0;
      const paseo = { hosts: {
        list: async () => ({ self: { serverId: "srv_linux" }, hosts: [{ serverId: "srv_mac", label: null }] }),
        client: async () => { lends++; return { agents: {}, dispose: async () => { disposed++; } }; },
      } } as unknown as PluginHandlerContext["paseo"];
      const first = await hostRoute(paseo, "srv_mac");
      expect(first).toMatchObject({ kind: "remote", host: "srv_mac" });
      if (first.kind === "remote") first.release(false);
      await vi.advanceTimersByTimeAsync(59_000);
      const second = await hostRoute(paseo, "srv_mac");
      if (second.kind === "remote") second.release(false);
      await vi.advanceTimersByTimeAsync(59_000);
      expect({ lends, disposed }).toEqual({ lends: 1, disposed: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(disposed).toBe(1);
      await hostRoute(paseo, "srv_mac");
      expect(lends).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("gives up on a host that does not answer in time, and returns the late API at once", async () => {
    vi.useFakeTimers();
    try {
      let disposed = 0, answer: (() => void) | null = null;
      const paseo = { hosts: {
        list: async () => ({ self: { serverId: "srv_linux" }, hosts: [{ serverId: "srv_mac", label: "MacBook" }] }),
        client: () => new Promise((resolve) => { answer = () => resolve({ agents: {}, dispose: async () => { disposed++; } }); }),
      } } as unknown as PluginHandlerContext["paseo"];
      const pending = hostRoute(paseo, "srv_mac", { connectMs: 8_000 });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toEqual({ kind: "offline", host: "MacBook" });
      answer!(); await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

import { expect, test } from "vitest";

import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import {
  PiSessionCompaction,
  parseAutoCompactMode,
  type PiAutoCompactRuntime,
} from "./session-compaction.js";

function createCompaction() {
  const items: ProviderTimelineItem[] = [];
  let refreshCalls = 0;
  const compaction = new PiSessionCompaction({
    timeline: (item) => items.push(item),
    refreshUsage: () => {
      refreshCalls += 1;
    },
  });
  return { compaction, items, refreshCalls: () => refreshCalls };
}

function createRuntime(state: { autoCompactionEnabled?: boolean }): PiAutoCompactRuntime & {
  setCalls: boolean[];
} {
  const setCalls: boolean[] = [];
  return {
    setCalls,
    async getState() {
      return {
        sessionId: "pi-session",
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        messageCount: 0,
        pendingMessageCount: 0,
        ...(state.autoCompactionEnabled === undefined
          ? {}
          : { autoCompactionEnabled: state.autoCompactionEnabled }),
      };
    },
    async setAutoCompaction(enabled: boolean) {
      setCalls.push(enabled);
    },
  };
}

test("parseAutoCompactMode accepts upstream on/off synonyms and toggle", () => {
  for (const value of ["on", "true", "enable", "enabled", " ON "]) {
    expect(parseAutoCompactMode(value)).toBe(true);
  }
  for (const value of ["off", "false", "disable", "disabled", " Off "]) {
    expect(parseAutoCompactMode(value)).toBe(false);
  }
  expect(parseAutoCompactMode(undefined)).toBe("toggle");
  expect(parseAutoCompactMode("toggle")).toBe("toggle");
  expect(parseAutoCompactMode("banana")).toBe("unknown");
  expect(parseAutoCompactMode("")).toBe("unknown");
});

test("loading and completed share one stable id and refresh usage once", () => {
  const { compaction, items, refreshCalls } = createCompaction();

  compaction.handleEvent("loading", "manual");
  compaction.handleEvent("completed", "manual");

  expect(items).toHaveLength(2);
  const [loading, completed] = items;
  expect(loading).toMatchObject({ type: "compaction", status: "loading", trigger: "manual" });
  expect(completed).toMatchObject({ type: "compaction", status: "completed", trigger: "manual" });
  expect(loading?.id).toBe(completed?.id);
  expect(refreshCalls()).toBe(1);
  expect(compaction.activeCompaction).toBeNull();
});

test("first trigger wins for a loading/completed pair", () => {
  const { compaction, items } = createCompaction();

  compaction.handleEvent("loading", "auto");
  compaction.handleEvent("completed", "manual");

  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ status: "completed", trigger: "auto" });
});

test("duplicate completed transitions are ignored", () => {
  const { compaction, items, refreshCalls } = createCompaction();
  compaction.beginManual("client-1");

  compaction.handleEvent("loading", "manual");
  compaction.handleEvent("completed", "manual");
  compaction.handleEvent("completed", "manual");

  expect(items).toHaveLength(2);
  expect(refreshCalls()).toBe(1);
  expect(compaction.manualCommand).toMatchObject({ completed: true, outcome: "completed" });
  compaction.endManual();
});

test("beginManual rejects a second manual command while one is active", () => {
  const { compaction } = createCompaction();
  compaction.beginManual("client-1");
  expect(() => compaction.beginManual("client-2")).toThrow(
    "A Pi compact command is already running",
  );
  compaction.endManual();
});

test("completeManualAfterFailure closes a started loading item", () => {
  const { compaction, items } = createCompaction();
  compaction.beginManual("client-1");
  compaction.handleEvent("loading", "manual");

  expect(compaction.completeManualAfterFailure()).toBe(true);

  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ status: "completed", trigger: "manual" });
  expect(items[0]?.id).toBe(items[1]?.id);
  expect(compaction.manualCommand).toMatchObject({ completed: true, outcome: "error" });
  compaction.endManual();
});

test("completeManualAfterFailure without a start records error but emits nothing", () => {
  const { compaction, items } = createCompaction();
  compaction.beginManual("client-1");

  expect(compaction.completeManualAfterFailure()).toBe(false);

  expect(items).toHaveLength(0);
  expect(compaction.manualCommand).toMatchObject({ completed: false, outcome: "error" });
  compaction.endManual();
});

test("manual outcome space round-trips caller-reported outcomes", () => {
  const { compaction } = createCompaction();
  compaction.beginManual("client-1");
  compaction.recordOutcome("canceled");
  expect(compaction.manualCommand?.outcome).toBe("canceled");
  compaction.recordOutcome("retry");
  expect(compaction.manualCommand?.outcome).toBe("retry");
  compaction.recordOutcome("skipped");
  expect(compaction.manualCommand?.outcome).toBe("skipped");
  compaction.endManual();
  expect(compaction.manualCommand).toBeNull();
});

test("runAutoCompact applies explicit on/off", async () => {
  const { compaction } = createCompaction();
  const runtime = createRuntime({});

  await expect(compaction.runAutoCompact("off", runtime)).resolves.toEqual({
    ok: true,
    enabled: false,
    message: "Auto-compaction disabled.",
  });
  expect(runtime.setCalls).toEqual([false]);

  await expect(compaction.runAutoCompact("ON", runtime)).resolves.toEqual({
    ok: true,
    enabled: true,
    message: "Auto-compaction enabled.",
  });
  expect(runtime.setCalls).toEqual([false, true]);
});

test("runAutoCompact rejects unknown modes without touching RPC", async () => {
  const { compaction } = createCompaction();
  const runtime = createRuntime({});

  await expect(compaction.runAutoCompact("banana", runtime)).resolves.toEqual({
    ok: false,
    kind: "usage",
    message: "[Error] Usage: /autocompact [on|off|toggle]",
  });
  expect(runtime.setCalls).toEqual([]);
});

test("runAutoCompact toggle re-reads native state", async () => {
  const { compaction } = createCompaction();

  const disabled = createRuntime({ autoCompactionEnabled: false });
  await expect(compaction.runAutoCompact(undefined, disabled)).resolves.toEqual({
    ok: true,
    enabled: true,
    message: "Auto-compaction enabled.",
  });
  expect(disabled.setCalls).toEqual([true]);

  const enabled = createRuntime({ autoCompactionEnabled: true });
  await expect(compaction.runAutoCompact("toggle", enabled)).resolves.toEqual({
    ok: true,
    enabled: false,
    message: "Auto-compaction disabled.",
  });
  expect(enabled.setCalls).toEqual([false]);
});

test("runAutoCompact toggle fails visibly when native state is unavailable", async () => {
  const { compaction } = createCompaction();
  const runtime = createRuntime({});

  await expect(compaction.runAutoCompact(undefined, runtime)).resolves.toEqual({
    ok: false,
    kind: "unavailable",
    message:
      "[Error] Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
  });
  expect(runtime.setCalls).toEqual([]);
});

test("runAutoCompact surfaces setAutoCompaction failures", async () => {
  const { compaction } = createCompaction();
  const runtime = createRuntime({ autoCompactionEnabled: false });
  runtime.setAutoCompaction = async () => {
    throw new Error("rpc down");
  };

  await expect(compaction.runAutoCompact("on", runtime)).resolves.toEqual({
    ok: false,
    kind: "failed",
    message: "[Error] Failed to set auto-compaction: rpc down",
  });
});

test("runAutoCompact toggle fails visibly when the state read rejects", async () => {
  const { compaction } = createCompaction();
  const runtime = createRuntime({ autoCompactionEnabled: true });
  runtime.getState = async () => {
    throw new Error("Pi disconnected");
  };
  await expect(compaction.runAutoCompact("toggle", runtime)).resolves.toEqual({
    ok: false,
    kind: "unavailable",
    message: "[Error] Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
  });
});

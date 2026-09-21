import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { createPaseoExtension } from "./session.js";

interface FakePi {
  handlers: Map<string, (event: unknown, ctx: FakeCtx) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: FakeCtx) => unknown }>;
}

interface FakeCtx {
  sessionManager: { getEntries(): FakeEntry[] };
  ui: { notify(message: string, level?: string): void };
  navigateTree?(targetId: string, options?: unknown): Promise<unknown>;
}

interface FakeEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: { role: string; content: unknown };
}

async function loadExtension(systemPrompt?: string) {
  const extension = createPaseoExtension(systemPrompt ?? "Paseo system prompt");
  try {
    const module = await import(pathToFileURL(extension.path).href) as {
      default: (pi: {
        on(event: string, handler: (event: unknown, ctx: FakeCtx) => unknown): void;
        registerCommand(name: string, command: { handler: (args: string, ctx: FakeCtx) => unknown }): void;
      }) => void;
    };
    const pi: FakePi = { handlers: new Map(), commands: new Map() };
    module.default({
      on: (event, handler) => { pi.handlers.set(event, handler); },
      registerCommand: (name, command) => { pi.commands.set(name, command); },
    });
    return { extension, pi };
  } catch (error) {
    extension.cleanup();
    throw error;
  }
}

function makeCtx(entries: FakeEntry[], notified: string[]): FakeCtx {
  return {
    sessionManager: { getEntries: () => entries },
    ui: { notify: (message) => { notified.push(message); } },
  };
}

function payload(args: string): { targetId?: string; requestId?: string } {
  return JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8")) as {
    targetId?: string;
    requestId?: string;
  };
}

test("writes an importable Pi extension", async () => {
  const { extension, pi } = await loadExtension("Paseo system prompt");
  try {
    const listeners = pi.handlers;
    expect(await listeners.get("before_agent_start")?.({ systemPrompt: "Pi prompt" }, makeCtx([], []))).toEqual({
      systemPrompt: "Pi prompt\n\nPaseo system prompt",
    });
    expect(pi.commands.get("paseo_tree")).toBeDefined();
    expect(pi.commands.get("paseo_capture_entries")).toBeDefined();
  } finally {
    extension.cleanup();
  }
});

test("emits entry capture on session start", async () => {
  const { extension, pi } = await loadExtension();
  try {
    const notified: string[] = [];
    const entries: FakeEntry[] = [
      { type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } },
    ];
    await pi.handlers.get("session_start")?.({}, makeCtx(entries, notified));
    expect(notified).toHaveLength(1);
    expect(notified[0]?.startsWith("PASEO_ENTRY_CAPTURE ")).toBe(true);
    expect(JSON.parse(notified[0]?.slice("PASEO_ENTRY_CAPTURE ".length) ?? "")).toMatchObject({
      reason: "session_start",
      entries: [{ id: "e1", parentId: null, text: "hello" }],
    });
  } finally {
    extension.cleanup();
  }
});

test("matches submitted user entries by reference equality", async () => {
  const { extension, pi } = await loadExtension();
  try {
    const userMessage = { role: "user", content: "edited after submit" };
    const entries: FakeEntry[] = [
      { type: "message", id: "e9", parentId: "e8", message: userMessage },
    ];
    const notified: string[] = [];
    const ctx = makeCtx(entries, notified);
    await pi.handlers.get("message_end")?.({ message: userMessage }, ctx);
    await pi.handlers.get("message_start")?.({ message: { role: "assistant" } }, ctx);
    expect(notified).toHaveLength(1);
    expect(JSON.parse(notified[0]?.slice("PASEO_SUBMITTED_USER_ENTRY ".length) ?? "")).toEqual({
      entry: { id: "e9", parentId: "e8", text: "edited after submit" },
    });
  } finally {
    extension.cleanup();
  }
});

test("capture command emits entries keyed by request id", async () => {
  const { extension, pi } = await loadExtension();
  try {
    const notified: string[] = [];
    const entries: FakeEntry[] = [
      { type: "message", id: "e2", parentId: "e1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ];
    const args = Buffer.from(JSON.stringify({ requestId: "req-1", reason: "history" })).toString("base64url");
    await pi.commands.get("paseo_capture_entries")?.handler(args, makeCtx(entries, notified));
    expect(JSON.parse(notified[0]?.slice("PASEO_ENTRY_CAPTURE ".length) ?? "")).toMatchObject({
      reason: "command",
      requestId: "req-1",
      entries: [{ id: "e2", parentId: "e1", text: "hi" }],
    });
  } finally {
    extension.cleanup();
  }
});

test("tree command reports success and failure with correlated results", async () => {
  const { extension, pi } = await loadExtension();
  try {
    const notified: string[] = [];
    const navigated: string[] = [];
    const ctx: FakeCtx = {
      ...makeCtx([], notified),
      navigateTree: async (targetId) => {
        navigated.push(targetId);
        if (targetId === "bad") throw new Error("no such entry");
        return { ok: true };
      },
    };
    const goodArgs = Buffer.from(JSON.stringify({ targetId: "e1", requestId: "req-tree" })).toString("base64url");
    await pi.commands.get("paseo_tree")?.handler(goodArgs, ctx);
    expect(navigated).toEqual(["e1"]);
    expect(payload(goodArgs).targetId).toBe("e1");
    const result = JSON.parse(notified.pop()?.slice("PASEO_COMMAND_RESULT ".length) ?? "");
    expect(result).toMatchObject({ requestId: "req-tree", ok: true });
    const badArgs = Buffer.from(JSON.stringify({ targetId: "bad", requestId: "req-bad" })).toString("base64url");
    await expect(pi.commands.get("paseo_tree")?.handler(badArgs, ctx)).rejects.toThrow("no such entry");
    const failure = JSON.parse(notified.pop()?.slice("PASEO_COMMAND_RESULT ".length) ?? "");
    expect(failure).toMatchObject({ requestId: "req-bad", ok: false, error: "no such entry" });
  } finally {
    extension.cleanup();
  }
});

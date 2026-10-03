import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRpcOptions } from "../server/pi-rpc.js";
import { PiRpcTimeoutError } from "../server/pi-rpc.js";
import { SessionStore } from "../server/persistence.js";
import { createSuperpiSession, type SuperpiSessionOptions } from "../server/session.js";
import { SUBPI_CHILD_CHANNEL_PREFIX } from "../shared/subagents.js";
import { FakePiRpc } from "../tests/fixtures/fake-pi-rpc.js";

let root: string;
let cwd: string;
let stateDirectory: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "superpi-session-"));
  cwd = path.join(root, "workspace");
  stateDirectory = path.join(root, "state");
  await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    cwd,
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
    ...overrides,
  };
}

function harness(options: {
  fake?: FakePiRpc;
  config?: ProviderSessionConfig;
  persistence?: SuperpiSessionOptions["persistence"];
  history?: "replay" | "skip";
} = {}) {
  const fake = options.fake ?? new FakePiRpc();
  const events: ProviderEvent[] = [];
  let launch: PiRpcOptions | undefined;
  const session = createSuperpiSession({
    sessionId: "host-1",
    config: options.config ?? baseConfig(),
    persistence: options.persistence,
    history: options.history ?? "skip",
    stateDirectory,
    command: "pi",
    companionPath: "/companions/superpi-extension.js",
    createPiRpc: async (rpcOptions) => {
      launch = rpcOptions;
      return fake;
    },
    emit: (event) => {
      ProviderEventSchema.parse(event);
      events.push(event);
    },
  });
  return { session, fake, events, getLaunch: () => launch };
}

function ofType<T extends ProviderEvent["type"]>(
  events: readonly ProviderEvent[],
  type: T,
): Array<Extract<ProviderEvent, { type: T }>> {
  return events.filter((event): event is Extract<ProviderEvent, { type: T }> => event.type === type);
}

describe("root launch", () => {
  it("launches Pi with normal resources, the companion, owned session dir, and a session key", async () => {
    const { session, getLaunch } = harness({
      config: baseConfig({ model: "test/model", thinkingOption: "high", systemPrompt: "host guidance" }),
    });
    await session.open("open-1");
    const launch = getLaunch();
    expect(launch).toBeDefined();
    expect(launch?.command).toBe("pi");
    expect(launch?.args?.slice(0, 4)).toEqual(["--mode", "rpc", "--session-dir", expect.any(String)]);
    expect(launch?.args).toEqual(
      expect.arrayContaining([
        "--model",
        "test/model",
        "--thinking",
        "high",
        "--append-system-prompt",
        "host guidance",
        "--extension",
        "/companions/superpi-extension.js",
        "--superpi-companion-root",
      ]),
    );
    expect(launch?.args).not.toContain("--session");
    expect(typeof launch?.env?.SUPERPI_SESSION_KEY).toBe("string");
    expect(launch?.env?.SUPERPI_COMPANION_ROLE).toBeUndefined();
    await session.close();
  });

  it("restores a recorded transcript with --session and replays get_messages", async () => {
    const store = await SessionStore.open(stateDirectory, cwd);
    const transcript = path.join(store.sessionDirectory, "session.jsonl");
    await fs.writeFile(transcript, "{}\n");
    await store.recordNative("pi-session-1", transcript);
    const persistence = store.persistence;
    await store.release();

    const fake = new FakePiRpc({
      state: {
        sessionId: "pi-session-1",
        sessionFile: transcript,
        model: { provider: "test", id: "model", name: "Model", reasoning: true, contextWindow: 1000 },
        thinkingLevel: "medium",
      },
      messages: [{ role: "user", id: "u1", content: "restored" }],
    });
    const { session, events, getLaunch } = harness({ fake, persistence, history: "replay" });
    await session.open("open-1");
    const launch = getLaunch();
    expect(launch?.args).toContain("--session");
    expect(launch?.args?.[launch?.args.indexOf("--session") + 1]).toBe(transcript);
    expect(fake.requestsOfType("get_messages")).toHaveLength(1);
    const userItems = ofType(events, "timeline.item").filter((event) => event.item.type === "user_message");
    expect(userItems).toHaveLength(1);
    await session.close();
  });
});

describe("session open", () => {
  it("publishes handshake configuration, commands, persistence, and readiness", async () => {
    const fake = new FakePiRpc({
      state: {
        sessionId: "pi-session-1",
        sessionFile: undefined,
        model: {
          provider: "test",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          contextWindow: 2000,
          thinkingLevelMap: { xhigh: null },
        },
        thinkingLevel: "high",
      },
      models: [
        { provider: "test", id: "reasoner", name: "Reasoner", reasoning: true, contextWindow: 2000 },
        { provider: "test", id: "plain", name: "Plain", reasoning: false, contextWindow: 1000 },
      ],
      levels: ["off", "high"],
      commands: [
        { name: "superpi-control", description: "Superpi companion" },
        { name: "skill", description: "Run a skill" },
      ],
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");

    const opened = ofType(events, "session.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.capabilities).toEqual([
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "session.persistence",
      "session.configure",
      "session.subsession",
      "session.revert.conversation",
      "permission",
    ]);

    const config = ofType(events, "session.config")[0]?.config;
    expect(config?.model).toBe("test/reasoner");
    expect(config?.thinkingOption).toBe("high");
    expect(config?.modes).toEqual([]);
    expect(config?.models.map((model) => model.id)).toEqual(["test/reasoner", "test/plain"]);
    const reasoner = config?.models.find((model) => model.id === "test/reasoner");
    expect(reasoner?.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(config?.thinkingOptions.map((option) => option.id)).toEqual(["off", "high"]);
    expect(config?.settings.map((setting) => setting.id)).toEqual(["tier", "longContext"]);

    expect(ofType(events, "session.commands")[0]?.commands).toEqual([
      { name: "skill", description: "Run a skill" },
    ]);
    expect(ofType(events, "session.persistence")).toHaveLength(1);
    expect(ofType(events, "session.ready")[0]?.requestId).toBe("open-1");

    const order = events.map((event) => event.type);
    expect(order.indexOf("session.opened")).toBeLessThan(order.indexOf("session.ready"));
    expect(order.indexOf("session.config")).toBeLessThan(order.indexOf("session.ready"));
    expect(order.indexOf("session.persistence")).toBeLessThan(order.indexOf("session.ready"));
    await session.close();
  });

  it("rejects unsupported mode, tool policy, MCP, and settings without opening", async () => {
    const cases: Array<Partial<ProviderSessionConfig>> = [
      { mode: "plan" },
      { toolPolicy: { preapproved: [{ kind: "mcp", server: "srv", tool: "tool" }] } },
      {
        mcpServers: {
          srv: { type: "stdio", command: "mcp-server" },
        },
      },
      { settings: { unknown: true } },
    ];
    for (const overrides of cases) {
      const { session, events } = harness({ config: baseConfig(overrides) });
      await session.open("open-1");
      expect(ofType(events, "session.opened")).toHaveLength(0);
      const failure = ofType(events, "request.failed")[0];
      expect(failure?.requestId).toBe("open-1");
      expect(failure?.error.message.length).toBeGreaterThan(0);
      await session.close();
    }
  });
});

describe("prompt admission", () => {
  it("emits exactly one turn result and settles on agent_settled after events precede the response", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDisposition: "started",
      onPrompt: () => {
        fake.emit({ type: "message_start", message: { role: "user", id: "u1", content: "hello" } });
        fake.emit({ type: "message_start", message: { role: "assistant", id: "a1" } });
        fake.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
        });
        fake.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hi there" },
        });
        fake.emit({ type: "agent_settled" });
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;

    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hello" }] },
    });

    const results = ofType(events, "session.prompt_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.clientMessageId).toBe("client-1");
    expect(results[0]?.result).toEqual({ type: "turn", turnId: expect.any(String) });

    const turns = ofType(events, "session.turn");
    expect(turns.map((turn) => turn.state)).toEqual(["started", "completed"]);

    const userItem = ofType(events, "timeline.item").find((event) => event.item.type === "user_message");
    expect(userItem?.item).toMatchObject({ type: "user_message", clientMessageId: "client-1", text: "hello" });
    const assistantItem = ofType(events, "timeline.item")
      .filter((event) => event.item.type === "assistant_message")
      .at(-1);
    expect(assistantItem?.item).toMatchObject({ type: "assistant_message", text: "Hi there" });
    await session.close();
  });

  it("maps queued admission to a steer result referencing the active turn", async () => {
    const fake = new FakePiRpc({ promptDisposition: "queued" });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-q",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "queued" }] },
    });
    const results = ofType(events, "session.prompt_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toEqual({ type: "steer", turnId: expect.any(String) });
    expect(ofType(events, "session.turn")).toHaveLength(0);
    await session.close();
  });

  it("maps handled commands to a completed result without inventing a turn", async () => {
    const fake = new FakePiRpc({ promptDisposition: "handled" });
    const { session, events, getLaunch } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-h",
      delivery: "auto",
      input: { type: "command", name: "skill", arguments: "now" },
    });
    const results = ofType(events, "session.prompt_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toEqual({ type: "completed" });
    expect(ofType(events, "session.turn")).toHaveLength(0);
    expect(fake.requestsOfType("prompt").at(-1)?.message).toBe("/skill now");
    const manifestPath = path.join(path.dirname(getLaunch()!.args![3]!), "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(manifest.interrupted).toBe(false);
    await session.close();
  });

  it("does not impose an admission timeout on a registered extension command's blocking dialog", async () => {
    const fake = new FakePiRpc({
      promptDisposition: "handled",
      commands: [{ name: "superpi-control" }, { name: "editor-test" }],
    });
    const request = vi.spyOn(fake, "request");
    const { session } = harness({ fake });
    await session.open("open-1");
    await session.prompt({
      clientMessageId: "editor-command",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "/editor-test" }] },
    });
    expect(request).toHaveBeenCalledWith({ type: "prompt", message: "/editor-test" }, 0);
    await session.close();
  });

  it("does not bind a later user row to a refused prompt", async () => {
    const fake = new FakePiRpc({ onRequest(command) {
      if (command.message === "refused") throw new Error("Prompt refused before admission");
      if (command.message === "accepted") {
        fake.emit({ type: "message_start", message: { role: "user", timestamp: 42, content: "accepted" } });
        fake.emit({ type: "message_end", message: { role: "user", timestamp: 42, content: "accepted" } });
        fake.emit({ type: "agent_settled" });
      }
    } });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    const input = (clientMessageId: string, text: string) => ({
      clientMessageId, delivery: "auto" as const,
      input: { type: "message" as const, content: [{ type: "text" as const, text }] },
    });
    await expect(session.prompt(input("refused-id", "refused"))).rejects.toThrow("refused");
    await session.prompt(input("accepted-id", "accepted"));
    expect(ofType(events, "timeline.item").find((event) => event.item.type === "user_message")?.item)
      .toMatchObject({ clientMessageId: "accepted-id" });
    await session.close();
  });

  it("folds tool execution streaming into standard tool call snapshots", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDisposition: "started",
      onPrompt: () => {
        fake.emit({
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "ls" },
        });
        fake.emit({
          type: "tool_execution_update",
          toolCallId: "t1",
          toolName: "bash",
          partialResult: { output: "half" },
        });
        fake.emit({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          result: { output: "done" },
          isError: false,
        });
        fake.emit({ type: "agent_settled" });
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-tool",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "run" }] },
    });
    const toolItems = ofType(events, "timeline.item")
      .filter((event) => event.item.type === "tool_call")
      .map((event) => event.item);
    expect(toolItems.at(-1)).toMatchObject({
      type: "tool_call",
      callId: "t1",
      name: "bash",
      status: "completed",
      detail: { type: "shell", command: "ls" },
    });
    await session.close();
  });

  it("interrupts by clearing the queue and aborting, then cancels the active turn", async () => {
    const fake = new FakePiRpc({ promptDisposition: "started" });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    });
    events.length = 0;
    await session.interrupt("int-1");
    expect(fake.requestsOfType("clear_queue")).toHaveLength(1);
    expect(fake.requestsOfType("abort")).toHaveLength(1);
    expect(ofType(events, "request.completed")[0]?.requestId).toBe("int-1");
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("canceled");
    await session.close();
  });

  it("renders an omission note instead of dropping an image for a text-only model", async () => {
    const { session, fake } = harness();
    await session.open("open-1");
    await session.prompt({
      clientMessageId: "client-img",
      delivery: "auto",
      input: {
        type: "message",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      },
    });
    const sessionPrompts = fake
      .requestsOfType("prompt")
      .filter((record) => !String(record.message).startsWith("/superpi-control "));
    expect(sessionPrompts).toHaveLength(1);
    expect(String(sessionPrompts[0]?.message)).toContain("does not accept image input");
    expect(sessionPrompts[0]?.images).toBeUndefined();
    await session.close();
  });

  it("forwards inline images when the selected model accepts image input", async () => {
    const fake = new FakePiRpc({
      state: {
        sessionId: "pi-session-1",
        model: {
          provider: "test",
          id: "vision",
          name: "Vision",
          reasoning: false,
          contextWindow: 1000,
          input: ["text", "image"],
        },
        thinkingLevel: "medium",
      },
    });
    const { session } = harness({ fake });
    await session.open("open-1");
    await session.prompt({
      clientMessageId: "client-img",
      delivery: "auto",
      input: {
        type: "message",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      },
    });
    const sessionPrompts = fake
      .requestsOfType("prompt")
      .filter((record) => !String(record.message).startsWith("/superpi-control "));
    expect(sessionPrompts).toHaveLength(1);
    expect(sessionPrompts[0]?.images).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    await session.close();
  });
});

describe("failure and cleanup", () => {
  it("emits runtime_failed once on process loss and cleans up idempotently", async () => {
    const fake = new FakePiRpc({ promptDisposition: "started" });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    });

    fake.fail(new Error("Pi crashed"));
    await session.close();
    await session.close();

    expect(ofType(events, "session.runtime_failed")).toHaveLength(1);
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("failed");
    expect(fake.closed).toBe(true);
  });
});

describe("stage 1 hardening", () => {
  it("rejects an invalid companion handshake instead of ignoring it", async () => {
    const fake = new FakePiRpc({ helloData: { settings: { tier: "bogus" } } });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    expect(ofType(events, "session.ready")).toHaveLength(0);
    const failure = ofType(events, "request.failed")[0];
    expect(failure?.requestId).toBe("open-1");
    expect(failure?.error.message.length).toBeGreaterThan(0);
  });

  it("refreshes native state and publishes persistence before the terminal turn", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDisposition: "started",
      onPrompt: () => {
        fake.emit({ type: "message_start", message: { role: "user", id: "u1", content: "hi" } });
        fake.emit({ type: "agent_settled" });
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hi" }] },
    });
    const completed = events.findIndex(
      (event) => event.type === "session.turn" && event.state === "completed",
    );
    const persistence = events.findIndex((event) => event.type === "session.persistence");
    expect(completed).toBeGreaterThan(-1);
    expect(persistence).toBeGreaterThan(-1);
    expect(persistence).toBeLessThan(completed);
    await session.close();
  });

  it("maps an error stop reason to a failed terminal turn", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDisposition: "started",
      onPrompt: () => {
        fake.emit({ type: "message_start", message: { role: "user", id: "u1", content: "hi" } });
        fake.emit({ type: "message_start", message: { role: "assistant", id: "a1" } });
        fake.emit({
          type: "message_end",
          message: { role: "assistant", id: "a1", stopReason: "error" },
        });
        fake.emit({ type: "agent_settled" });
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hi" }] },
    });
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("failed");
    await session.close();
  });

  it("maps an aborted stop reason to a canceled terminal turn", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDisposition: "started",
      onPrompt: () => {
        fake.emit({ type: "message_start", message: { role: "user", id: "u1", content: "hi" } });
        fake.emit({ type: "message_start", message: { role: "assistant", id: "a1" } });
        fake.emit({
          type: "message_end",
          message: { role: "assistant", id: "a1", stopReason: "aborted" },
        });
        fake.emit({ type: "agent_settled" });
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hi" }] },
    });
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("canceled");
    await session.close();
  });

  it("completes when a transient error stop is followed by a normal stop", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDisposition: "started",
      onPrompt: () => {
        fake.emit({ type: "message_start", message: { role: "user", id: "u1", content: "hi" } });
        fake.emit({ type: "message_start", message: { role: "assistant", id: "a1" } });
        fake.emit({
          type: "message_end",
          message: { role: "assistant", id: "a1", stopReason: "error" },
        });
        fake.emit({
          type: "message_end",
          message: { role: "assistant", id: "a2", stopReason: "stop" },
        });
        fake.emit({ type: "agent_settled" });
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hi" }] },
    });
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("completed");
    await session.close();
  });

  it("honors cancel intent when settlement precedes the abort reply", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDisposition: "started",
      onRequest: (command) => {
        if (command.type === "clear_queue") fake.emit({ type: "agent_settled" });
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    });
    events.length = 0;
    await session.interrupt("int-1");
    expect(ofType(events, "session.turn").at(-1)?.state).toBe("canceled");
    expect(ofType(events, "request.completed")[0]?.requestId).toBe("int-1");
    await session.close();
  });

  it("fails every pending prompt exactly once on close", async () => {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releasePrompt!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const fake = new FakePiRpc({
      onRequest: async (command) => {
        if (command.type === "prompt" && !String(command.message).startsWith("/superpi-control ")) {
          enteredResolve();
          await gate;
        }
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    const pending = session
      .prompt({
        clientMessageId: "client-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hi" }] },
      })
      .catch(() => undefined);
    await entered;
    await session.close();
    releasePrompt({ disposition: "started" });
    await pending;
    const results = ofType(events, "session.prompt_result").filter(
      (event) => event.clientMessageId === "client-1",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.result.type).toBe("failed");
  });

  it("invalidates the runtime after an uncertain prompt timeout", async () => {
    const fake = new FakePiRpc({
      onRequest: (command) => {
        if (command.type === "prompt" && !String(command.message).startsWith("/superpi-control ")) {
          throw new PiRpcTimeoutError("prompt timed out");
        }
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await expect(
      session.prompt({
        clientMessageId: "client-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hi" }] },
      }),
    ).rejects.toThrow("prompt timed out");
    expect(ofType(events, "session.runtime_failed")).toHaveLength(1);
    await expect(
      session.prompt({
        clientMessageId: "client-2",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "again" }] },
      }),
    ).rejects.toThrow("not ready");
  });

  it("ends an active turn canceled exactly once on close", async () => {
    const fake = new FakePiRpc({ promptDisposition: "started" });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    await session.prompt({
      clientMessageId: "client-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    });
    events.length = 0;
    await session.close();
    await session.close();
    const terminals = ofType(events, "session.turn").filter((turn) => turn.state !== "started");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.state).toBe("canceled");
  });

  it("emits the interrupted notice for a prior interrupted manifest", async () => {
    const store = await SessionStore.open(stateDirectory, cwd);
    await store.save({ interrupted: true });
    const persistence = store.persistence;
    await store.release();
    const { session, events } = harness({ persistence, history: "skip" });
    await session.open("open-1");
    expect(ofType(events, "session.notice")[0]?.notice.id).toBe("interrupted-run");
    await session.close();
  });
});

describe("stage 2 configuration", () => {
  it("applies a core model change and publishes committed config before completion", async () => {
    let currentModel: Record<string, unknown> = {
      provider: "test",
      id: "model",
      name: "Model",
      reasoning: true,
      contextWindow: 1000,
    };
    const fake = new FakePiRpc({
      stateProvider: () => ({ sessionId: "pi-session-1", model: currentModel, thinkingLevel: "medium" }),
      onRequest: (command) => {
        if (command.type === "set_model") {
          currentModel = {
            provider: String(command.provider),
            id: String(command.modelId),
            name: "Other",
            reasoning: true,
            contextWindow: 1000,
          };
        }
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.configure("cfg-1", { model: "test/other" });
    expect(fake.requestsOfType("set_model").at(-1)).toMatchObject({
      provider: "test",
      modelId: "other",
    });
    expect(ofType(events, "session.config")[0]?.config.model).toBe("test/other");
    const configIndex = events.findIndex((event) => event.type === "session.config");
    const completedIndex = events.findIndex((event) => event.type === "request.completed");
    expect(configIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeLessThan(completedIndex);
    await session.close();
  });

  it("applies companion tier and long-context settings and retains them across a model change", async () => {
    const fake = new FakePiRpc();
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.configure("cfg-1", { settings: { tier: "fast", longContext: true } });
    expect(fake.companionSettings).toEqual({ tier: "fast", longContext: true });
    const first = ofType(events, "session.config")[0]?.config;
    expect(first?.settings.find((setting) => setting.id === "tier")?.value).toBe("fast");
    expect(first?.settings.find((setting) => setting.id === "longContext")?.value).toBe(true);

    await session.configure("cfg-2", { model: "test/other" });
    const second = ofType(events, "session.config")[1]?.config;
    expect(second?.settings.find((setting) => setting.id === "tier")?.value).toBe("fast");
    expect(second?.settings.find((setting) => setting.id === "longContext")?.value).toBe(true);
    expect(fake.companionSettings).toEqual({ tier: "fast", longContext: true });
    await session.close();
  });

  it("applies explicit composer settings during open before ready", async () => {
    const fake = new FakePiRpc();
    const { session, events } = harness({
      fake,
      config: baseConfig({ settings: { tier: "fast", longContext: true } }),
    });
    await session.open("open-1");
    expect(fake.companionSettings).toEqual({ tier: "fast", longContext: true });
    const config = ofType(events, "session.config")[0]?.config;
    expect(config?.settings.find((setting) => setting.id === "tier")?.value).toBe("fast");
    expect(config?.settings.find((setting) => setting.id === "longContext")?.value).toBe(true);
    const readyIndex = events.findIndex((event) => event.type === "session.ready");
    const configIndex = events.findIndex((event) => event.type === "session.config");
    expect(configIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeLessThan(readyIndex);
    await session.close();
  });

  it("restores saved companion settings on reload and lets explicit values override", async () => {
    const saved = { tier: "fast", longContext: true };
    const reloadFake = new FakePiRpc({
      helloData: {
        capabilities: ["tier", "context"],
        settings: { ...saved },
        sessionId: "pi-session-1",
      },
    });
    const reload = harness({ fake: reloadFake });
    await reload.session.open("open-1");
    const restored = ofType(reload.events, "session.config")[0]?.config;
    expect(restored?.settings.find((setting) => setting.id === "tier")?.value).toBe("fast");
    expect(restored?.settings.find((setting) => setting.id === "longContext")?.value).toBe(true);
    await reload.session.close();

    const overrideFake = new FakePiRpc({
      helloData: {
        capabilities: ["tier", "context"],
        settings: { ...saved },
        sessionId: "pi-session-1",
      },
    });
    const override = harness({
      fake: overrideFake,
      config: baseConfig({ settings: { tier: "flex" } }),
    });
    await override.session.open("open-1");
    expect(overrideFake.companionSettings).toEqual({ tier: "flex", longContext: true });
    const merged = ofType(override.events, "session.config")[0]?.config;
    expect(merged?.settings.find((setting) => setting.id === "tier")?.value).toBe("flex");
    expect(merged?.settings.find((setting) => setting.id === "longContext")?.value).toBe(true);
    await override.session.close();
  });

  it("rejects unknown settings during open without opening the session", async () => {
    const fake = new FakePiRpc();
    const { session, events } = harness({ fake, config: baseConfig({ settings: { bogus: true } }) });
    await session.open("open-1");
    expect(ofType(events, "session.opened")).toHaveLength(0);
    expect(ofType(events, "session.ready")).toHaveLength(0);
    expect(ofType(events, "request.failed")[0]?.error.message).toContain("bogus");
    await session.close();
  });

  it("rejects unsupported settings and invalid tiers honestly", async () => {
    const fake = new FakePiRpc();
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.configure("cfg-1", { settings: { unknown: true } });
    await session.configure("cfg-2", { settings: { tier: "bogus" } });
    const failures = ofType(events, "request.failed");
    expect(failures.map((failure) => failure.requestId)).toEqual(["cfg-1", "cfg-2"]);
    await session.close();
  });

  it("launches non-persistent sessions without a manifest and with --no-session", async () => {
    const { session, events, getLaunch } = harness({ config: baseConfig({ persist: false }) });
    await session.open("open-1");
    const launch = getLaunch();
    expect(launch?.args).toContain("--no-session");
    expect(launch?.args).not.toContain("--session-dir");
    expect(ofType(events, "session.opened")[0]?.persistence).toBeUndefined();
    expect(ofType(events, "session.persistence")).toHaveLength(0);
    await expect(fs.stat(stateDirectory)).rejects.toThrow();
    await session.close();
  });

  it("rejects compact while busy and runs it only when idle", async () => {
    let streaming = true;
    const fake = new FakePiRpc({
      stateProvider: () => ({
        sessionId: "pi-session-1",
        isStreaming: streaming,
        model: { provider: "test", id: "model", name: "Model", reasoning: true, contextWindow: 1000 },
        thinkingLevel: "medium",
      }),
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;
    await session.prompt({
      clientMessageId: "c1",
      delivery: "auto",
      input: { type: "command", name: "compact", arguments: "" },
    });
    expect(ofType(events, "session.prompt_result")[0]?.result.type).toBe("failed");
    expect(fake.requestsOfType("compact")).toHaveLength(0);

    streaming = false;
    await session.prompt({
      clientMessageId: "c2",
      delivery: "auto",
      input: { type: "command", name: "compact", arguments: "tight" },
    });
    expect(ofType(events, "session.prompt_result")[1]?.result.type).toBe("completed");
    expect(fake.requestsOfType("compact").at(-1)).toMatchObject({ customInstructions: "tight" });
    await session.close();
  });
});

function userEntry(
  id: string,
  parentId: string | null,
  timestamp: number,
): Record<string, unknown> {
  return { id, parentId, type: "message", message: { role: "user", timestamp, content: `msg ${id}` } };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  timestamp: number,
): Record<string, unknown> {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "assistant", timestamp, content: `reply ${id}` },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function childEnvelope(
  sessionKey: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    method: "notify",
    message: SUBPI_CHILD_CHANNEL_PREFIX + JSON.stringify({ version: 1, sessionKey, record }),
  };
}

function firstUserToken(events: readonly ProviderEvent[]): unknown {
  const item = ofType(events, "timeline.item").find(
    (event) => event.item.type === "user_message",
  );
  return item && item.item.type === "user_message" ? item.item.revertToken : undefined;
}

describe("root integration", () => {
  it("does not navigate if clearing old queued input fails", async () => {
    const onRewind = vi.fn();
    const fake = new FakePiRpc({
      entries: [userEntry("e-u1", null, 100)], leafId: "e-u1", onRewind,
      messages: [{ role: "user", timestamp: 100, content: "hello" }],
      onRequest(command) { if (command.type === "clear_queue") throw new Error("Queue clear refused"); },
    });
    const { session, events } = harness({ fake, history: "replay" });
    await session.open("open-1");
    const token = firstUserToken(events);
    await session.revert("queue-refusal", token, "conversation");
    expect(onRewind).not.toHaveBeenCalled();
    expect(ofType(events, "request.failed").at(-1)?.error.message).toContain("queued input");
    await session.close();
  });
  it("attaches active-branch rewind tokens and replays the rewound branch", async () => {
    const entries = [
      userEntry("e-u1", null, 100),
      assistantEntry("e-a1", "e-u1", 101),
      userEntry("e-u2", "e-a1", 102),
      assistantEntry("e-a2", "e-u2", 103),
    ];
    let leafId: string | null = "e-a2";
    let messages: unknown[] = [
      { role: "user", timestamp: 100, content: "hello" },
      { role: "assistant", timestamp: 101, content: "hi" },
      { role: "user", timestamp: 102, content: "again" },
      { role: "assistant", timestamp: 103, content: "more" },
    ];
    const fake = new FakePiRpc({
      entriesProvider: () => ({ entries, leafId }),
      messagesProvider: () => messages,
      clearQueue: { steering: ["stale"], followUp: [] },
      onRewind: () => {
        // navigateTree moves the leaf to the selected user entry's parent.
        leafId = "e-a1";
        messages = messages.slice(0, 2);
      },
    });
    const { session, events } = harness({ fake, history: "replay" });
    await session.open("open-1");
    const tokenFor = (entryId: string) =>
      ofType(events, "timeline.item")
        .map((event) => event.item)
        .find(
          (item) =>
            item.type === "user_message" &&
            (item.revertToken as { entryId?: string } | undefined)?.entryId === entryId,
        )?.revertToken;
    expect(tokenFor("e-u1")).toMatchObject({ version: 1, entryId: "e-u1" });
    const targetToken = tokenFor("e-u2");
    expect(targetToken).toBeDefined();
    events.length = 0;

    await session.revert("rev-1", targetToken, "conversation");

    expect(ofType(events, "request.completed")[0]?.requestId).toBe("rev-1");
    expect(
      ofType(events, "session.notice").some((notice) => notice.notice.id === "rewind-queue-cleared"),
    ).toBe(true);
    const forbidden = ["write", "bash", "fork", "new_session", "switch_session", "clone"];
    expect(
      fake.requests
        .map((record) => String(record.type))
        .filter((type) => forbidden.includes(type)),
    ).toEqual([]);
    const postUsers = ofType(events, "timeline.item")
      .filter((event) => event.item.type === "user_message")
      .map((event) => event.item);
    // Only the retained first user row is replayed, and it keeps its token.
    expect(postUsers).toHaveLength(1);
    expect(postUsers[0]).toMatchObject({ id: "user:100", revertToken: { entryId: "e-u1" } });
    await session.close();
  });

  it("rejects stale or foreign rewind tokens without navigating", async () => {
    const entries = [userEntry("e-u1", null, 100)];
    const fake = new FakePiRpc({ entries, leafId: "e-u1" });
    const { session, events } = harness({ fake, history: "replay" });
    await session.open("open-1");
    const token = firstUserToken(events) as Record<string, unknown>;
    events.length = 0;
    fake.requests.length = 0;

    await session.revert("rev-foreign", { version: 1, owner: "other", entryId: "e-u1" }, "conversation");
    await session.revert("rev-offbranch", { ...token, entryId: "e-missing" }, "conversation");

    const failures = ofType(events, "request.failed");
    expect(failures.map((failure) => failure.requestId)).toEqual(["rev-foreign", "rev-offbranch"]);
    expect(
      fake.requestsOfType("prompt").some((record) => String(record.message).includes("superpi-control")),
    ).toBe(false);
    await session.close();
  });

  it("guards rewind while owned children are active and keeps them across interrupt", async () => {
    const entries = [userEntry("e-u1", null, 100)];
    const fake = new FakePiRpc({ entries, leafId: "e-u1" });
    const { session, events, getLaunch } = harness({ fake, history: "replay" });
    await session.open("open-1");
    const token = firstUserToken(events);
    const sessionKey = String(getLaunch()?.env?.SUPERPI_SESSION_KEY);

    fake.emit(
      childEnvelope(sessionKey, {
        version: 1,
        runId: "run-1",
        sequence: 1,
        type: "created",
        title: "Child",
      }),
    );
    await flush();
    await flush();
    const childOpened = ofType(events, "session.opened").find(
      (event) => event.sessionId === "superpi-child:run-1",
    );
    expect(childOpened).toBeDefined();
    expect(childOpened?.cwd).toBe(cwd);

    events.length = 0;
    await session.revert("rev-1", token, "conversation");
    expect(ofType(events, "request.failed")[0]?.error.message).toContain("child");

    events.length = 0;
    await session.interrupt("int-1");
    expect(
      ofType(events, "session.turn").filter((turn) => turn.sessionId === "superpi-child:run-1"),
    ).toHaveLength(0);

    await session.close();
    expect(
      ofType(events, "session.turn").some(
        (turn) => turn.sessionId === "superpi-child:run-1" && turn.state === "failed",
      ),
    ).toBe(true);
  });

  it("reports a canceled navigation and cleared queues honestly", async () => {
    const entries = [userEntry("e-u1", null, 100)];
    const fake = new FakePiRpc({
      entries,
      leafId: "e-u1",
      messages: [{ role: "user", timestamp: 100, content: "hello" }],
      clearQueue: { steering: ["one"], followUp: ["two"] },
      rewindData: {
        cancelled: true,
        targetEntryId: "e-u1",
        settings: { tier: "default", longContext: false },
        activeChildren: 0,
      },
    });
    const { session, events } = harness({ fake, history: "replay" });
    await session.open("open-1");
    const token = firstUserToken(events);
    events.length = 0;

    await session.revert("rev-1", token, "conversation");

    expect(ofType(events, "request.failed")[0]?.error.message).toContain("cancelled");
    expect(
      ofType(events, "session.notice").some((notice) => notice.notice.id === "rewind-queue-cleared"),
    ).toBe(true);
    await session.close();
  });

  it("closes honestly when a rewind outcome is indeterminate", async () => {
    const entries = [userEntry("e-u1", null, 100)];
    const fake = new FakePiRpc({
      entries,
      leafId: "e-u1",
      messages: [{ role: "user", timestamp: 100, content: "hello" }],
      rewindError: "companion rewind timed out; its outcome may be uncertain",
    });
    const { session, events } = harness({ fake, history: "replay" });
    await session.open("open-1");
    const token = firstUserToken(events);
    events.length = 0;

    await session.revert("rev-1", token, "conversation");

    expect(ofType(events, "request.failed")[0]?.error.message).toContain("indeterminate");
    expect(ofType(events, "session.runtime_failed")).toHaveLength(1);
    expect(session.currentState).not.toBe("ready");
    await session.close();
    expect(session.currentState).toBe("closed");
  });

  it("fails a clean companion rejection without tearing down the session", async () => {
    const entries = [userEntry("e-u1", null, 100)];
    const fake = new FakePiRpc({
      entries,
      leafId: "e-u1",
      messages: [{ role: "user", timestamp: 100, content: "hello" }],
      rewindError: "rewind requires an idle agent",
    });
    const { session, events } = harness({ fake, history: "replay" });
    await session.open("open-1");
    const token = firstUserToken(events);
    events.length = 0;

    await session.revert("rev-1", token, "conversation");

    expect(ofType(events, "request.failed")[0]?.error.message).toBe("rewind requires an idle agent");
    expect(ofType(events, "session.runtime_failed")).toHaveLength(0);
    expect(session.currentState).toBe("ready");
    await session.close();
  });

  it("bridges native blocking dialogs and routes permission responses", async () => {
    const fake = new FakePiRpc();
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;

    fake.emit({
      type: "extension_ui_request",
      id: "d1",
      method: "select",
      title: "Pick",
      options: ["Allow", "Block"],
    });
    expect(ofType(events, "session.permission")[0]?.request.id).toBe("d1");

    await session.respondPermission("d1", { behavior: "allow", updatedInput: { value: "Allow" } });
    expect(fake.sent.at(-1)).toMatchObject({
      type: "extension_ui_response",
      id: "d1",
      value: "Allow",
    });
    expect(ofType(events, "session.permission_resolved")[0]?.permissionId).toBe("d1");
    await session.close();
  });

  it("renders ordinary notifications and consumes companion replies", async () => {
    const fake = new FakePiRpc();
    const { session, events } = harness({ fake });
    await session.open("open-1");
    const companionNoise = ofType(events, "timeline.item").filter(
      (event) => event.item.type === "notification" && event.item.message.includes("superpi:v1:"),
    );
    expect(companionNoise).toHaveLength(0);

    events.length = 0;
    fake.emit({ type: "extension_ui_request", method: "notify", message: "plain notice", level: "warning" });
    const notification = ofType(events, "timeline.item").find(
      (event) => event.item.type === "notification",
    );
    expect(notification?.item).toMatchObject({
      type: "notification",
      level: "warning",
      message: "plain notice",
    });
    await session.close();
  });
});

describe("bounded final fixes", () => {
  function transcriptFile(cwdPath: string, lines: string[]): string {
    return [
      JSON.stringify({ type: "session", version: 3, id: "native-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: cwdPath }),
      ...lines,
    ].join("\n") + "\n";
  }

  function nativeUser(id: string, parentId: string | null, timestamp: number): string {
    return JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: "user", content: `msg ${id}`, timestamp },
    });
  }

  it("restores a >8MiB transcript and builds rewind tokens without lifetime RPC queries", async () => {
    const store = await SessionStore.open(stateDirectory, cwd);
    const transcript = path.join(store.sessionDirectory, "session.jsonl");
    const bigAssistant = JSON.stringify({
      type: "message",
      id: "e-a1",
      parentId: "e-u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        timestamp: 101,
        content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
      },
    });
    await fs.writeFile(
      transcript,
      transcriptFile(cwd, [nativeUser("e-u1", null, 100), bigAssistant]),
    );
    expect((await fs.stat(transcript)).size).toBeGreaterThan(8 * 1024 * 1024);
    await store.recordNative("pi-session-1", transcript);
    const persistence = store.persistence;
    await store.release();

    const fake = new FakePiRpc({
      state: {
        sessionId: "pi-session-1",
        sessionFile: transcript,
        model: { provider: "test", id: "model", name: "Model", reasoning: false, contextWindow: 1000 },
        thinkingLevel: "medium",
      },
      messages: [{ role: "user", timestamp: 100, content: "restored" }],
    });
    const { session, events } = harness({ fake, persistence, history: "replay" });
    await session.open("open-1");

    expect(ofType(events, "session.ready")).toHaveLength(1);
    expect(fake.requestsOfType("get_entries")).toHaveLength(0);
    expect(fake.requestsOfType("get_messages")).toHaveLength(0);
    const userItem = ofType(events, "timeline.item").find(
      (event) => event.item.type === "user_message",
    );
    expect(userItem?.item).toMatchObject({ revertToken: { version: 1, entryId: "e-u1" } });
    await session.close();
  });

  it("rejects a rewind that starts while a prompt admission is still pending", async () => {
    const store = await SessionStore.open(stateDirectory, cwd);
    const persistence = store.persistence;
    await store.release();
    const onRewind = vi.fn();
    const entries = [userEntry("e-u1", null, 100)];
    const fake = new FakePiRpc({
      entries,
      leafId: "e-u1",
      messages: [{ role: "user", timestamp: 100, content: "hello" }],
      onRewind,
    });
    const { session, events } = harness({ fake, persistence, history: "replay" });
    await session.open("open-1");
    const token = firstUserToken(events);
    events.length = 0;

    // Do not await: admission is recorded synchronously before the prompt's
    // first await, so the rewind below must observe it and refuse.
    const pending = session.prompt({
      clientMessageId: "race",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    });
    await session.revert("rev-race", token, "conversation");
    expect(onRewind).not.toHaveBeenCalled();
    const failure = ofType(events, "request.failed").find(
      (event) => event.requestId === "rev-race",
    );
    expect(failure?.error.message).toContain("busy");
    await pending;
    await session.close();
  });

  it("binds a later user row to its own admission after interrupt clears the queue", async () => {
    let fake: FakePiRpc;
    fake = new FakePiRpc({
      promptDispositionProvider: (command) =>
        String(command.message).includes("first") ? "queued" : "started",
      onPrompt: (command) => {
        const message = String(command.message);
        if (message.includes("first")) {
          fake.emit({ type: "message_start", message: { role: "user", timestamp: 1, content: "first" } });
          fake.emit({ type: "message_end", message: { role: "user", timestamp: 1, content: "first" } });
        } else if (message.includes("later")) {
          fake.emit({ type: "message_start", message: { role: "user", timestamp: 2, content: "later" } });
          fake.emit({ type: "message_end", message: { role: "user", timestamp: 2, content: "later" } });
          fake.emit({ type: "agent_settled" });
        }
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    const input = (clientMessageId: string, text: string) => ({
      clientMessageId, delivery: "auto" as const,
      input: { type: "message" as const, content: [{ type: "text" as const, text }] },
    });
    await session.prompt(input("first-id", "first"));
    await session.interrupt("int-1");
    events.length = 0;
    await session.prompt(input("later-id", "later"));
    const later = ofType(events, "timeline.item")
      .filter((event) => event.item.type === "user_message")
      .at(-1);
    expect(later?.item).toMatchObject({ clientMessageId: "later-id" });
    await session.close();
  });

  it("gives compaction no admission timeout and holds the in-flight guard until it settles", async () => {
    let releaseCompact!: () => void;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    const fake = new FakePiRpc({
      onRequest: async (command) => {
        if (command.type === "compact") await compactGate;
      },
    });
    const request = vi.spyOn(fake, "request");
    const { session, events } = harness({ fake });
    await session.open("open-1");
    events.length = 0;

    const compacting = session.prompt({
      clientMessageId: "compact-1",
      delivery: "auto",
      input: { type: "command", name: "compact", arguments: "" },
    });
    await flush();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "compact" }), 0);
    await expect(
      session.prompt({
        clientMessageId: "blocked",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "blocked" }] },
      }),
    ).rejects.toThrow("compacting");

    releaseCompact();
    await compacting;
    expect(ofType(events, "session.prompt_result").at(-1)?.result).toEqual({ type: "completed" });
    await session.close();
  });

  it("routes a blocking startup dialog emitted before ready", async () => {
    let emitted = false;
    const fake = new FakePiRpc({
      onRequest: (command) => {
        if (command.type === "get_state" && !emitted) {
          emitted = true;
          fake.emit({
            type: "extension_ui_request",
            id: "startup",
            method: "select",
            title: "Pick",
            options: ["A", "B"],
          });
        }
      },
    });
    const { session, events } = harness({ fake });
    await session.open("open-1");
    const permissionIndex = events.findIndex((event) => event.type === "session.permission");
    const readyIndex = events.findIndex((event) => event.type === "session.ready");
    expect(permissionIndex).toBeGreaterThan(-1);
    expect(permissionIndex).toBeLessThan(readyIndex);
    expect(ofType(events, "session.permission")[0]?.request.id).toBe("startup");
    await session.close();
  });
});

describe("interrupt cancels pending dialogs", () => {
  it("cancels a pending editor dialog before clearing the native queue", async () => {
    const fake = new FakePiRpc();
    const { session, events } = harness({ fake });
    await session.open("open-1");
    fake.emit({
      type: "extension_ui_request",
      id: "editor-1",
      method: "editor",
      title: "Edit",
      prefill: "seed",
    });
    expect(ofType(events, "session.permission")[0]?.request.id).toBe("editor-1");
    events.length = 0;

    await session.interrupt("int-1");

    expect(fake.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "extension_ui_response", id: "editor-1", cancelled: true }),
      ]),
    );
    expect(ofType(events, "session.permission_resolved")[0]?.permissionId).toBe("editor-1");
    expect(ofType(events, "request.completed")[0]?.requestId).toBe("int-1");
    await session.close();
  });
});

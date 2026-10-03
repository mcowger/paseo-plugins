import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiRpcOptions } from "../server/pi-rpc.js";
import { createSuperpiProvider, discoverCatalog } from "../server/provider.js";
import { FakePiRpc } from "../tests/fixtures/fake-pi-rpc.js";

let root: string;
let cwd: string;
let stateDirectory: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "superpi-provider-"));
  cwd = path.join(root, "workspace");
  stateDirectory = path.join(root, "state");
  await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const OFFERED = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.persistence",
  "session.revert.conversation",
  "session.configure",
];

function sessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return { cwd, env: {}, mcpServers: {}, settings: {}, persist: true, ...overrides };
}

function collect() {
  const events: ProviderEvent[] = [];
  return {
    events,
    listener: (event: ProviderEvent) => {
      ProviderEventSchema.parse(event);
      events.push(event);
    },
  };
}

function ofType<T extends ProviderEvent["type"]>(
  events: readonly ProviderEvent[],
  type: T,
): Array<Extract<ProviderEvent, { type: T }>> {
  return events.filter((event): event is Extract<ProviderEvent, { type: T }> => event.type === type);
}

describe("capability negotiation", () => {
  it("advertises only the tested stage 1 capabilities", async () => {
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => new FakePiRpc(),
    });
    const connection = await provider.registration.connect({
      versions: [1],
      capabilities: OFFERED,
    });
    expect(connection.version).toBe(1);
    expect(connection.capabilities).toEqual([
      "prompt.message",
      "prompt.command",
      "prompt.image",
      "session.persistence",
      "session.revert.conversation",
      "session.configure",
    ]);
    await provider.close();
  });

  it("publishes only the negotiated capabilities on session.opened", async () => {
    const fake = new FakePiRpc();
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => fake,
    });
    const connection = await provider.registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const { events, listener } = collect();
    connection.onEvent(listener);
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    expect(ofType(events, "session.opened")[0]?.capabilities).toEqual(["prompt.message"]);
    await provider.close();
  });
});

describe("catalog discovery", () => {
  it("runs a temporary no-session process, maps models, and closes it", async () => {
    const fake = new FakePiRpc({
      state: {
        model: { provider: "test", id: "reasoner", name: "Reasoner", reasoning: true, contextWindow: 2000 },
        thinkingLevel: "medium",
      },
      models: [
        { provider: "test", id: "reasoner", name: "Reasoner", reasoning: true, contextWindow: 2000 },
        { provider: "test", id: "plain", name: "Plain", reasoning: false, contextWindow: 1000 },
      ],
      levels: ["off", "medium", "high"],
    });
    const launches: PiRpcOptions[] = [];
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async (options) => {
        launches.push(options);
        return fake;
      },
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);

    await connection.send({ type: "catalog", requestId: "cat-1", cwd });

    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toEqual(["--mode", "rpc", "--no-session"]);
    expect(launches[0]?.cwd).toBe(cwd);
    expect(fake.closed).toBe(true);

    const catalog = ofType(events, "catalog")[0]?.catalog;
    expect(catalog?.defaultModel).toBe("test/reasoner");
    expect(catalog?.defaultThinkingOption).toBe("medium");
    expect(catalog?.modes).toEqual([]);
    expect(catalog?.models.map((model) => model.id)).toEqual(["test/reasoner", "test/plain"]);
    expect(catalog?.thinkingOptions?.map((option) => option.id)).toEqual(["off", "medium", "high"]);

    await provider.close();
  });

  it("discovers directly without a companion handshake and reports failures", async () => {
    const fake = new FakePiRpc({ models: [{ provider: "test", id: "m", name: "M", reasoning: false }] });
    const catalog = await discoverCatalog({
      command: "pi",
      cwd,
      createRpc: async () => fake,
    });
    expect(catalog.models.map((model) => model.id)).toEqual(["test/m"]);
    expect(fake.closed).toBe(true);

    const failing = {
      ...new FakePiRpc(),
      request: async () => {
        throw new Error("no pi");
      },
      close: async () => undefined,
    } as unknown as FakePiRpc;
    await expect(
      discoverCatalog({ command: "pi", cwd, createRpc: async () => failing }),
    ).rejects.toThrow("no pi");
  });

  it("propagates unconfirmed cleanup when discovery itself succeeded", async () => {
    const fake = new FakePiRpc({ models: [{ provider: "test", id: "m", name: "M", reasoning: false }] });
    fake.close = async () => {
      throw new Error("close unconfirmed");
    };
    await expect(
      discoverCatalog({ command: "pi", cwd, createRpc: async () => fake }),
    ).rejects.toThrow("close unconfirmed");
  });
});

describe("input handling", () => {
  it("reports unsupported stage 1 inputs honestly", async () => {
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => new FakePiRpc(),
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);

    await connection.send({ type: "session.configure", requestId: "cfg-1", sessionId: "s", changes: {} });
    await connection.send({ type: "session.revert", requestId: "rev-1", sessionId: "s", token: null, scope: "conversation" });
    await connection.send({ type: "session.archive", requestId: "arc-1", persistence: { version: 1, data: {} } });
    await connection.send({ type: "session.unarchive", requestId: "una-1", persistence: { version: 1, data: {} } });
    await connection.send({ type: "session.permission", sessionId: "s", permissionId: "p", response: { behavior: "deny" } });

    expect(ofType(events, "request.failed").map((event) => event.requestId)).toEqual([
      "cfg-1",
      "rev-1",
      "arc-1",
      "una-1",
    ]);
    await provider.close();
  });

  it("routes session.open, prompt, and close through one owned session", async () => {
    const fake = new FakePiRpc({ promptDisposition: "started" });
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => fake,
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);

    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    expect(ofType(events, "session.ready")[0]?.requestId).toBe("open-1");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "client-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    const results = ofType(events, "session.prompt_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toEqual({ type: "turn", turnId: expect.any(String) });

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    expect(ofType(events, "session.closed")[0]?.sessionId).toBe("session-1");
    expect(ofType(events, "request.completed")[0]?.requestId).toBe("close-1");

    await provider.close();
  });

  it("completes close for an unknown session without hanging the host", async () => {
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => new FakePiRpc(),
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);

    await connection.send({ type: "session.close", requestId: "close-x", sessionId: "missing" });
    expect(ofType(events, "session.closed")[0]?.sessionId).toBe("missing");
    expect(ofType(events, "request.completed")[0]?.requestId).toBe("close-x");
    await provider.close();
  });

  it("routes session.configure through the owned session", async () => {
    const fake = new FakePiRpc();
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => fake,
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);

    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { settings: { tier: "flex" } },
    });
    expect(fake.requestsOfType("prompt").length).toBeGreaterThan(0);
    expect(fake.companionSettings.tier).toBe("flex");
    expect(ofType(events, "request.completed").map((event) => event.requestId)).toContain("cfg-1");
    await provider.close();
  });

  it("fails a duplicate session id without replacing the live session", async () => {
    const fake = new FakePiRpc();
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => fake,
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);

    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    await connection.send({
      type: "session.open",
      requestId: "open-2",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    const failures = ofType(events, "request.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.requestId).toBe("open-2");
    await provider.close();
  });
});

describe("dialog registry and permissions", () => {
  it("exposes a dialog registry and routes registered answers", async () => {
    const fake = new FakePiRpc();
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => fake,
    });
    expect(provider.dialogs.list()).toEqual([]);

    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    fake.emit({
      type: "extension_ui_request",
      id: "d1",
      method: "confirm",
      title: "Go?",
      message: "Proceed",
    });
    expect(ofType(events, "session.permission")[0]?.request.id).toBe("d1");
    const view = provider.dialogs.list().find((entry) => entry.permissionId === "d1");
    expect(view?.sessionId).toBe("session-1");
    expect(typeof view?.generation).toBe("string");

    const resolved = await provider.dialogs.answer("session-1", "d1", {
      behavior: "allow",
      value: true,
    });
    expect(resolved).toBe(true);
    expect(fake.sent.at(-1)).toMatchObject({
      type: "extension_ui_response",
      id: "d1",
      confirmed: true,
    });
    expect(provider.dialogs.list()).toEqual([]);
    await provider.close();
  });

  it("routes a host session.permission response to the owning bridge", async () => {
    const fake = new FakePiRpc();
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => fake,
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    fake.emit({
      type: "extension_ui_request",
      id: "d2",
      method: "select",
      title: "Pick",
      options: ["A", "B"],
    });
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: "d2",
      response: { behavior: "deny" },
    });
    expect(fake.sent.at(-1)).toMatchObject({
      type: "extension_ui_response",
      id: "d2",
      cancelled: true,
    });
    await provider.close();
  });
});

describe("session map cleanup", () => {
  it("removes a failed session so the same id can be opened again", async () => {
    const bad = new FakePiRpc({ helloData: { settings: { tier: "bogus" } } });
    const good = new FakePiRpc();
    let call = 0;
    const provider = createSuperpiProvider({
      companionPath: "/companions/superpi-extension.js",
      stateDirectory,
      createPiRpc: async () => (++call === 1 ? bad : good),
    });
    const connection = await provider.registration.connect({ versions: [1], capabilities: OFFERED });
    const { events, listener } = collect();
    connection.onEvent(listener);

    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    expect(ofType(events, "session.ready")).toHaveLength(0);
    expect(ofType(events, "session.closed")).toHaveLength(1);

    await connection.send({
      type: "session.open",
      requestId: "open-2",
      sessionId: "session-1",
      config: sessionConfig(),
      history: "skip",
    });
    expect(ofType(events, "session.ready")[0]?.requestId).toBe("open-2");
    await provider.close();
  });
});

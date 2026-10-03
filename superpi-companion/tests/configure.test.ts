import { describe, expect, it } from "vitest";
import { createCompanion } from "../src/companion.ts";
import { CUSTOM_ENTRY_TYPE, encodeRequest, type SuperpiRequest } from "../src/protocol.ts";
import { createFakeContext, createFakePi, readReply, type FakeModel, type FakePi } from "./harness.ts";

const KEY = "key-1";

function configure(data: unknown, requestId = "configure-1"): string {
  return encodeRequest({ version: 1, sessionKey: KEY, requestId, operation: "configure", data });
}

function model(overrides: Partial<FakeModel> = {}): FakeModel {
  return { id: "gpt-5.6", api: "openai-responses", contextWindow: 200_000, provider: "plexus", ...overrides };
}

function setup(options: { model?: FakeModel; branch?: Array<Record<string, unknown>> } = {}) {
  const pi = createFakePi({ registry: options.model ? [options.model] : [] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY, now: () => 1234 });
  const fake = createFakeContext({ pi, model: options.model, branch: options.branch });
  return { pi, companion, ...fake };
}

function stateOf(reply: ReturnType<typeof readReply>) {
  return reply.data as Record<string, any>;
}

async function modelSelect(pi: FakePi, event: Record<string, unknown>, ctx: unknown): Promise<void> {
  await pi.handlers.get("model_select")?.[0]?.(event, ctx);
}

describe("configure", () => {
  it("applies a tier and persists a branch-local custom entry", async () => {
    const { pi, companion, ctx, notifies } = setup({ model: model() });

    await companion.handleArgs(configure({ tier: "fast" }), ctx);
    const reply = readReply(notifies);

    expect(reply.ok).toBe(true);
    expect(stateOf(reply).settings.tier).toBe("fast");
    expect(stateOf(reply).tierApplicable).toBe(true);

    const entry = pi.entries.at(-1);
    expect(entry?.customType).toBe(CUSTOM_ENTRY_TYPE);
    expect(entry?.data).toMatchObject({ version: 1, tier: "fast", longContext: false, timestamp: 1234 });
  });

  it("rejects unknown configure fields", async () => {
    const { companion, ctx, notifies } = setup();
    await companion.handleArgs(configure({ turbo: true }), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("invalid configure data");
  });

  it("expands a session-local clone without mutating the shared catalog", async () => {
    const catalog = model();
    const { pi, companion, ctx, notifies } = setup({ model: catalog });

    await companion.handleArgs(configure({ longContext: true }), ctx);
    let reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).settings.longContext).toBe(true);
    expect(stateOf(reply).contextWindow).toBe(1_050_000);
    expect(stateOf(reply).modelBaselineContextWindow).toBe(200_000);
    // The session-local clone is expanded; the catalog object is untouched.
    expect(pi.sessionModel?.contextWindow).toBe(1_050_000);
    expect(pi.setModelCalls).toHaveLength(1);
    expect(pi.setModelCalls[0]?.contextWindow).toBe(1_050_000);
    expect(catalog.contextWindow).toBe(200_000);
    // An owned child resolving through the registry keeps the baseline budget.
    expect(pi.findModel("plexus", "gpt-5.6")).toBe(catalog);
    expect(pi.findModel("plexus", "gpt-5.6")?.contextWindow).toBe(200_000);

    await companion.handleArgs(configure({ longContext: false }, "configure-2"), ctx);
    reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).settings.longContext).toBe(false);
    expect(stateOf(reply).contextWindow).toBe(200_000);
    expect(stateOf(reply).modelBaselineContextWindow).toBeUndefined();
    expect(pi.sessionModel?.contextWindow).toBe(200_000);
    expect(pi.setModelCalls).toHaveLength(2);
    expect(catalog.contextWindow).toBe(200_000);
  });

  it("derives the expanded budget from the baseline across repeated root toggles", async () => {
    const catalog = model();
    const { pi, companion, ctx, notifies } = setup({ model: catalog });

    await companion.handleArgs(configure({ longContext: true }), ctx);
    await companion.handleArgs(configure({ longContext: false }, "configure-2"), ctx);
    await companion.handleArgs(configure({ longContext: true }, "configure-3"), ctx);

    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).contextWindow).toBe(1_050_000);
    expect(stateOf(reply).modelBaselineContextWindow).toBe(200_000);
    expect(pi.setModelCalls.map((call) => call.contextWindow)).toEqual([1_050_000, 200_000, 1_050_000]);
    expect(catalog.contextWindow).toBe(200_000);
  });

  it("fails an honest error when the current model has no context window", async () => {
    const { companion, ctx, notifies } = setup();
    await companion.handleArgs(configure({ longContext: true }), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("context window");
    expect(stateOf(reply).settings.longContext).toBe(false);
  });

  it("reports a non-default tier as not applicable for an unknown API dialect", async () => {
    const { companion, ctx, notifies } = setup({
      model: model({ id: "mystery", api: "mystery-api", contextWindow: 100_000 }),
    });

    await companion.handleArgs(configure({ tier: "flex" }), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).settings.tier).toBe("flex");
    expect(stateOf(reply).tierApplicable).toBe(false);
  });

  it("restores branch-local settings on session_start as a session-local clone", async () => {
    const catalog = model();
    const branch = [
      {
        type: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        data: { version: 1, tier: "ultrafast", longContext: true, contextWindow: 200_000, timestamp: 7 },
      },
    ];
    const pi = createFakePi({ registry: [catalog] });
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const fake = createFakeContext({ pi, model: catalog, branch });

    const handler = pi.handlers.get("session_start")?.[0];
    expect(handler).toBeDefined();
    await handler?.({ type: "session_start", reason: "resume" }, fake.ctx);

    const state = companion.buildState(fake.ctx);
    expect(state.settings).toEqual({ tier: "ultrafast", longContext: true });
    expect(state.contextWindow).toBe(1_050_000);
    expect(state.modelBaselineContextWindow).toBe(200_000);
    expect(pi.sessionModel?.contextWindow).toBe(1_050_000);
    expect(catalog.contextWindow).toBe(200_000);
  });
});

describe("configure atomicity", () => {
  it("leaves the previous tier and persistence untouched when long context fails", async () => {
    const { pi, companion, ctx, notifies } = setup();
    await companion.handleArgs(configure({ tier: "fast" }), ctx);
    expect(readReply(notifies).ok).toBe(true);
    const entriesAfterTier = pi.entries.length;

    await companion.handleArgs(configure({ tier: "ultrafast", longContext: true }, "configure-2"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("context window");
    expect(stateOf(reply).settings).toEqual({ tier: "fast", longContext: false });
    // A combined request that never applied must not persist a partial tier.
    expect(pi.entries).toHaveLength(entriesAfterTier);
  });

  it("reports a setModel refusal without changing either selection", async () => {
    const { pi, companion, ctx, notifies } = setup({ model: model() });
    pi.setModelRefuses = true;

    await companion.handleArgs(configure({ tier: "fast", longContext: true }), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("expanded model");
    expect(stateOf(reply).settings).toEqual({ tier: "default", longContext: false });
    expect(pi.entries).toHaveLength(0);
    expect(pi.sessionModel?.contextWindow).toBe(200_000);
  });
});

describe("model_select isolation", () => {
  it("re-applies expansion to a catalog model selected while long context is on", async () => {
    const catalog = model();
    const next = model({ id: "claude", api: "anthropic-messages", contextWindow: 300_000 });
    const pi = createFakePi({ registry: [catalog, next] });
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const fake = createFakeContext({ pi, model: catalog });

    await companion.handleArgs(configure({ longContext: true }), fake.ctx);
    // Simulate Pi switching the session to the next catalog model.
    pi.sessionModel = next;
    await modelSelect(pi, { type: "model_select", model: next, previousModel: catalog, source: "set" }, fake.ctx);

    expect(pi.sessionModel?.contextWindow).toBe(1_050_000);
    expect(next.contextWindow).toBe(300_000);
    expect(pi.setModelCalls.at(-1)?.contextWindow).toBe(1_050_000);
  });

  it("ignores its own session-local clone and catalog-less events", async () => {
    const catalog = model();
    const pi = createFakePi({ registry: [catalog] });
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const fake = createFakeContext({ pi, model: catalog });

    await companion.handleArgs(configure({ longContext: true }), fake.ctx);
    const calls = pi.setModelCalls.length;

    // The expanded clone is not in the registry; a repeated event must not apply again.
    const clone = { ...catalog, contextWindow: 1_050_000 };
    await modelSelect(pi, { type: "model_select", model: clone, previousModel: catalog, source: "set" }, fake.ctx);
    expect(pi.setModelCalls).toHaveLength(calls);

    const unknown = model({ id: "not-in-registry" });
    await modelSelect(pi, { type: "model_select", model: unknown, previousModel: catalog, source: "set" }, fake.ctx);
    expect(pi.setModelCalls).toHaveLength(calls);
  });

  it("does not expand while long context is off", async () => {
    const catalog = model();
    const next = model({ id: "claude", contextWindow: 300_000 });
    const pi = createFakePi({ registry: [catalog, next] });
    createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const fake = createFakeContext({ pi, model: catalog });

    await modelSelect(pi, { type: "model_select", model: next, previousModel: catalog, source: "set" }, fake.ctx);
    expect(pi.setModelCalls).toHaveLength(0);
    expect(next.contextWindow).toBe(300_000);
  });
});

describe("configure requirements", () => {
  it("echoes the request operation and request id", async () => {
    const { companion, ctx, notifies } = setup();
    const encoded = encodeRequest({
      version: 1,
      sessionKey: KEY,
      requestId: "custom-id",
      operation: "configure",
      data: {},
    } satisfies SuperpiRequest);
    await companion.handleArgs(encoded, ctx);
    const reply = readReply(notifies);
    expect(reply.requestId).toBe("custom-id");
    expect(reply.operation).toBe("configure");
  });
});

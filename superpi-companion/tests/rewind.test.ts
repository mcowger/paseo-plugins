import { describe, expect, it } from "vitest";
import { createCompanion } from "../src/companion.ts";
import {
  CUSTOM_ENTRY_TYPE,
  encodeRequest,
  REWIND_ENTRY_TYPE,
  SUBAGENT_BRIDGE_CHANNEL,
  type SuperpiRequest,
} from "../src/protocol.ts";
import { createFakeContext, createFakePi, readReply, type FakeContextSeed } from "./harness.ts";

const KEY = "key-1";

function rewind(targetEntryId: string, requestId = "rewind-1"): string {
  return encodeRequest({ version: 1, sessionKey: KEY, requestId, operation: "rewind", data: { targetEntryId } });
}

function userEntry(id: string, parentId: string | null = null): Record<string, unknown> {
  return { id, parentId, type: "message", message: { role: "user", content: "hello" } };
}

function assistantEntry(id: string, parentId: string | null): Record<string, unknown> {
  return { id, parentId, type: "message", message: { role: "assistant", content: "hi" } };
}

function controlEntry(tier: string): Record<string, unknown> {
  return {
    id: "control-1",
    parentId: "u1",
    type: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    data: { version: 1, tier, longContext: false, timestamp: 1 },
  };
}

function setup(seed: FakeContextSeed = {}) {
  const pi = createFakePi({ registry: seed.model ? [seed.model] : [] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY, now: () => 55 });
  const fake = createFakeContext({ ...seed, pi });
  return { pi, companion, ...fake };
}

function stateOf(reply: ReturnType<typeof readReply>) {
  return reply.data as Record<string, any>;
}

describe("rewind guards", () => {
  it("rejects while the agent is busy", async () => {
    const { companion, ctx, notifies, navigations } = setup({ idle: false, branch: [userEntry("u1")] });
    await companion.handleArgs(rewind("u1"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("idle");
    expect(navigations).toHaveLength(0);
  });

  it("rejects while a compaction is in progress", async () => {
    const { pi, companion, ctx, notifies, navigations } = setup({ branch: [userEntry("u1")] });
    pi.handlers.get("session_before_compact")?.[0]?.({ type: "session_before_compact" }, ctx);
    await companion.handleArgs(rewind("u1"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("compaction");
    expect(navigations).toHaveLength(0);
  });

  it("rejects while owned children are active", async () => {
    const { pi, companion, ctx, notifies, navigations } = setup({ branch: [userEntry("u1")] });
    const start = pi.handlers.get("session_start")?.[0];
    start?.({ type: "session_start" }, ctx);
    pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, {
      version: 1,
      runId: "run-1",
      sequence: 1,
      type: "created",
      childSessionId: "child-1",
    });
    expect(companion.activeChildren()).toBe(1);

    await companion.handleArgs(rewind("u1"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("owned child");
    expect(navigations).toHaveLength(0);
  });
});

describe("rewind target validation", () => {
  it("rejects a target that is not on the active branch", async () => {
    const { companion, ctx, notifies, navigations } = setup({ branch: [userEntry("u1")] });
    await companion.handleArgs(rewind("missing"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("active branch");
    expect(navigations).toHaveLength(0);
  });

  it("rejects a non-user target", async () => {
    const { companion, ctx, notifies, navigations } = setup({
      branch: [userEntry("u1"), assistantEntry("a1", "u1")],
    });
    await companion.handleArgs(rewind("a1"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("user message");
    expect(navigations).toHaveLength(0);
  });

  it("rejects unknown rewind data", async () => {
    const { companion, ctx, notifies } = setup({ branch: [userEntry("u1")] });
    const encoded = encodeRequest({
      version: 1,
      sessionKey: KEY,
      requestId: "rewind-bad",
      operation: "rewind",
      data: { targetEntryId: "u1", surprise: true },
    } satisfies SuperpiRequest);
    await companion.handleArgs(encoded, ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("invalid rewind data");
  });
});

describe("rewind navigation", () => {
  it("navigates without summarization and pins the branch", async () => {
    const { pi, companion, ctx, notifies, navigations } = setup({
      branch: [userEntry("u1"), assistantEntry("a1", "u1"), userEntry("u2", "a1")],
      navigateLeafId: "a1",
    });
    await companion.handleArgs(rewind("u2"), ctx);

    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(navigations).toEqual([{ targetId: "u2", options: { summarize: false } }]);
    const data = stateOf(reply);
    expect(data.cancelled).toBe(false);
    expect(data.targetEntryId).toBe("u2");
    expect(data.leafId).toBe("a1");
    expect(data.settings).toEqual({ tier: "default", longContext: false });

    const pin = pi.entries.at(-1);
    expect(pin?.customType).toBe(REWIND_ENTRY_TYPE);
    expect(pin?.data).toMatchObject({ version: 1, targetEntryId: "u2", leafId: "a1", timestamp: 55 });
  });

  it("restores companion controls from the rewound branch", async () => {
    const { pi, companion, ctx, notifies } = setup({
      model: { provider: "plexus", id: "gpt", api: "openai-completions", contextWindow: 200000 },
      branch: [userEntry("u1"), assistantEntry("a1", "u1"), userEntry("u2", "a1"), controlEntry("ultrafast")],
      navigateLeafId: "a1",
    });
    await companion.handleArgs(rewind("u2"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).settings.tier).toBe("ultrafast");
    expect(pi.entries.at(-1)?.customType).toBe(REWIND_ENTRY_TYPE);
  });

  it("reports a cancelled navigation without pinning the branch", async () => {
    const { pi, companion, ctx, notifies } = setup({
      branch: [userEntry("u1"), assistantEntry("a1", "u1"), userEntry("u2", "a1")],
      navigateCancelled: true,
    });
    await companion.handleArgs(rewind("u2"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("cancelled");
    expect(stateOf(reply).cancelled).toBe(true);
    expect(pi.entries).toHaveLength(0);
  });

  it("reports a navigation error honestly", async () => {
    const { pi, companion, ctx, notifies } = setup({
      branch: [userEntry("u1"), assistantEntry("a1", "u1"), userEntry("u2", "a1")],
      navigateThrows: "Wait for the current compaction or tree navigation to finish",
    });
    await companion.handleArgs(rewind("u2"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("navigation failed");
    expect(pi.entries).toHaveLength(0);
  });
});

describe("root flag timing", () => {
  it("reads the root flag after the factory registers and only owns controls then", async () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { sessionKey: KEY });
    expect(companion.origin).toBe("child");
    pi.flags.set("superpi-companion-root", true);
    expect(companion.origin).toBe("root");

    const { ctx, notifies } = createFakeContext({ branch: [userEntry("u1")] });
    await companion.handleArgs(rewind("u1"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(reply.operation).toBe("rewind");
  });
});

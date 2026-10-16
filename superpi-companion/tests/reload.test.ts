import { describe, expect, it } from "vitest";
import { createCompanion } from "../src/companion.ts";
import { encodeRequest, SUBAGENT_BRIDGE_CHANNEL } from "../src/protocol.ts";
import { createFakeContext, createFakePi, readReply, type FakeContextSeed } from "./harness.ts";

const KEY = "key-1";

function reload(requestId = "reload-1"): string {
  return encodeRequest({ version: 1, sessionKey: KEY, requestId, operation: "reload" });
}

function setup(seed: FakeContextSeed = {}) {
  const pi = createFakePi({ registry: seed.model ? [seed.model] : [] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY, now: () => 55 });
  const fake = createFakeContext({ ...seed, pi });
  return { pi, companion, ...fake };
}

describe("reload", () => {
  it("replies ok before reloading when idle", async () => {
    const { companion, ctx, notifies, reloads } = setup();
    await companion.handleArgs(reload(), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(reply.operation).toBe("reload");
    expect(reloads).toHaveLength(1);
    // The ok reply was already emitted when ctx.reload() ran.
    expect(reloads[0]?.notifies).toBe(1);
  });

  it("rejects while the agent is busy", async () => {
    const { companion, ctx, notifies, reloads } = setup({ idle: false });
    await companion.handleArgs(reload(), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("busy");
    expect(reloads).toHaveLength(0);
  });

  it("rejects while a compaction is in progress", async () => {
    const { pi, companion, ctx, notifies, reloads } = setup();
    pi.handlers.get("session_before_compact")?.[0]?.({ type: "session_before_compact" }, ctx);
    await companion.handleArgs(reload(), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("compaction");
    expect(reloads).toHaveLength(0);
  });

  it("rejects while owned children are active", async () => {
    const { pi, companion, ctx, notifies, reloads } = setup();
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

    await companion.handleArgs(reload(), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("owned child");
    expect(reloads).toHaveLength(0);
  });
});

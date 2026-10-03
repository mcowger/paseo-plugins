import { describe, expect, it } from "vitest";
import { createCompanion } from "../src/companion.ts";
import { encodeRequest, type SuperpiRequest } from "../src/protocol.ts";
import { createFakeContext, createFakePi, readReply, type FakeContextSeed } from "./harness.ts";

const KEY = "key-1";

function compact(data: unknown = {}, requestId = "compact-1"): string {
  return encodeRequest({ version: 1, sessionKey: KEY, requestId, operation: "compact", data });
}

function setup(seed: FakeContextSeed = {}) {
  const pi = createFakePi();
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
  const fake = createFakeContext(seed);
  return { pi, companion, ...fake };
}

function stateOf(reply: ReturnType<typeof readReply>) {
  return reply.data as Record<string, any>;
}

describe("compact", () => {
  it("compacts only when idle and reports completion", async () => {
    const { companion, ctx, notifies, compactions } = setup();
    await companion.handleArgs(compact({ customInstructions: "keep the plan" }), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).compacted).toBe(true);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.options).toMatchObject({ customInstructions: "keep the plan" });
  });

  it("refuses while the agent is busy", async () => {
    const { companion, ctx, notifies, compactions } = setup({ idle: false });
    await companion.handleArgs(compact(), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("busy");
    expect(compactions).toHaveLength(0);
  });

  it("refuses when a compaction is already in progress", async () => {
    const { pi, companion, ctx, notifies, compactions } = setup();
    pi.handlers.get("session_before_compact")?.[0]?.({ type: "session_before_compact" }, ctx);
    await companion.handleArgs(compact(), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("already in progress");
    expect(compactions).toHaveLength(0);
  });

  it("reports a compaction error without claiming success", async () => {
    const { companion, ctx, notifies } = setup({ compactError: "no model available" });
    await companion.handleArgs(compact(), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("no model available");
  });

  it("does not emit a reply before the completion signal arrives", async () => {
    const { pi, companion, ctx, notifies, compactions } = setup({ compactAuto: false });
    const pending = companion.handleArgs(compact(), ctx);
    while (compactions.length === 0) await Promise.resolve();
    expect(notifies).toHaveLength(0);

    pi.handlers.get("session_compact")?.[0]?.({ type: "session_compact" }, ctx);
    await pending;
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).compacted).toBe(true);
  });

  it("refuses unknown compact data", async () => {
    const { companion, ctx, notifies } = setup();
    const encoded = encodeRequest({
      version: 1,
      sessionKey: KEY,
      requestId: "compact-bad",
      operation: "compact",
      data: { surprise: true },
    } satisfies SuperpiRequest);
    await companion.handleArgs(encoded, ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("invalid compact data");
  });
});

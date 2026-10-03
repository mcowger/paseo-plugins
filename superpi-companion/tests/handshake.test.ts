import { afterEach, describe, expect, it } from "vitest";
import { createCompanion, COMPANION_CAPABILITIES } from "../src/companion.ts";
import { encodeRequest, ROLE_ENV, ROOT_FLAG, SESSION_KEY_ENV, type SuperpiRequest } from "../src/protocol.ts";
import { createFakeContext, createFakePi, readReply } from "./harness.ts";

const KEY = "key-1";

function request(operation: SuperpiRequest["operation"], overrides: Partial<SuperpiRequest> = {}): string {
  return encodeRequest({
    version: 1,
    sessionKey: KEY,
    requestId: `${operation}-1`,
    operation,
    ...overrides,
  });
}

function stateOf(reply: ReturnType<typeof readReply>) {
  return reply.data as Record<string, any>;
}

afterEach(() => {
  delete process.env[SESSION_KEY_ENV];
  delete process.env[ROLE_ENV];
});

describe("hello handshake", () => {
  it("reads launch flags after extension registration rather than capturing their defaults", async () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { sessionKey: KEY });
    expect(companion.origin).toBe("child");
    pi.flags.set(ROOT_FLAG, true);
    const { ctx, notifies } = createFakeContext();
    await companion.handleArgs(request("hello"), ctx);
    expect(readReply(notifies).ok).toBe(true);
    expect(companion.origin).toBe("root");
  });
  it("reports the exact Stage 0 state shape with defaults", async () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext({
      model: { id: "gpt-5.6", api: "openai-responses", contextWindow: 200_000 },
      sessionId: "sess-42",
    });

    await companion.handleArgs(request("hello"), ctx);
    const reply = readReply(notifies);

    expect(reply.ok).toBe(true);
    expect(reply.operation).toBe("hello");
    expect(reply.requestId).toBe("hello-1");
    const data = stateOf(reply);
    expect(data.capabilities).toEqual([...COMPANION_CAPABILITIES]);
    expect(data.settings).toEqual({ tier: "default", longContext: false });
    expect(data.origin).toBe("root");
    expect(data.tiers).toEqual([]);
    expect(data.tierApplicable).toBe(false);
    expect(data.conflicts).toEqual([]);
    expect(data.longContextTarget).toBeUndefined();
    expect(data.longContextAvailable).toBe(false);
    expect(data.contextWindow).toBe(200_000);
    expect(data.sessionId).toBe("sess-42");
    expect(data.limitations.length).toBeGreaterThan(0);
    expect(notifies[0]?.level).toBe("info");
  });

  it("returns the same state for get-state", async () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext({
      model: { id: "gpt-5.6", api: "openai-responses", contextWindow: 200_000 },
    });

    await companion.handleArgs(request("get-state"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(reply.operation).toBe("get-state");
    expect(stateOf(reply).origin).toBe("root");
  });

  it("reports a known declared owner conflict with resolution", async () => {
    const pi = createFakePi({ commands: [{ name: "service-tier", source: "extension" }] });
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext();

    await companion.handleArgs(request("hello"), ctx);
    const reply = readReply(notifies);

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("plexus-pi");
    expect(reply.error).toContain("Disable");
    expect(stateOf(reply).conflicts).toHaveLength(1);
  });

  it("does not fail on unrelated extension commands", async () => {
    const pi = createFakePi({
      commands: [
        { name: "plexus-catalog", source: "extension" },
        { name: "my-plexus-factory", source: "extension" },
      ],
    });
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext();

    await companion.handleArgs(request("hello"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(stateOf(reply).conflicts).toEqual([]);
  });

  it("detects the root role from the launch environment", () => {
    process.env[ROLE_ENV] = "root";
    const pi = createFakePi();
    const companion = createCompanion(pi.api);
    expect(companion.origin).toBe("root");
  });
});

describe("session key enforcement", () => {
  it("rejects a request with a mismatched session key", async () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext();

    await companion.handleArgs(request("hello", { sessionKey: "other-key" }), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("mismatch");
  });

  it("rejects every request when SUPERPI_SESSION_KEY is unset", async () => {
    delete process.env[SESSION_KEY_ENV];
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { origin: "root" });
    const { ctx, notifies } = createFakeContext();

    await companion.handleArgs(request("hello"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(SESSION_KEY_ENV);
  });

  it("still emits a correlated reply for a malformed request", async () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext();

    await companion.handleArgs("!!!not-base64!!!", ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/base64url|JSON/);
    expect(reply.operation).toBe("hello");
  });
});

describe("root vs child envelope handling", () => {
  it("refuses control operations in a child session", async () => {
    const pi = createFakePi();
    const companion = createCompanion(pi.api, { origin: "child", sessionKey: KEY });
    const { ctx, notifies } = createFakeContext({
      model: { id: "gpt-5.6", api: "openai-responses", contextWindow: 200_000 },
    });

    await companion.handleArgs(request("hello"), ctx);
    const reply = readReply(notifies);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("root-only");
    expect(stateOf(reply).origin).toBe("child");
    expect(stateOf(reply).capabilities).toEqual([]);
  });
});

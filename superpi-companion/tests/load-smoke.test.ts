import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRequest, ROOT_FLAG, SESSION_KEY_ENV } from "../src/protocol.ts";
import { createFakeContext, createFakePi, readReply } from "./harness.ts";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.ts");
const KEY = "smoke-key";

afterEach(() => {
  delete process.env[SESSION_KEY_ENV];
});

describe("extension load smoke", () => {
  it("loads the real entry through Pi's jiti transform and serves no-model state", async () => {
    process.env[SESSION_KEY_ENV] = KEY;
    // Pi transforms TypeScript extensions with jiti, not native ESM. Loading the
    // real entry here catches module-initialization cycles that a plain import
    // against source files would not exercise in the same evaluation order.
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const factory = (await jiti.import(ENTRY, { default: true })) as (pi: unknown) => void;
    expect(typeof factory).toBe("function");

    const pi = createFakePi();
    factory(pi.api);
    pi.flags.set(ROOT_FLAG, true);

    const sessionStart = pi.handlers.get("session_start")?.[0];
    const { ctx, notifies } = createFakeContext({ branch: [] });
    sessionStart?.({ type: "session_start" }, ctx);

    const command = pi.commands.find((candidate) => candidate.name === "superpi-control");
    expect(command).toBeDefined();
    const hello = encodeRequest({ version: 1, sessionKey: KEY, requestId: "smoke-1", operation: "hello" });
    await command?.handler(hello, ctx);

    const reply = readReply(notifies);
    expect(reply.ok).toBe(true);
    expect(reply.operation).toBe("hello");
    const data = reply.data as Record<string, unknown>;
    expect(data.origin).toBe("root");
    expect(data.capabilities).toContain("rewind");
    expect(data.capabilities).toContain("compact");
    expect(data.contextWindow).toBeUndefined();
  });
});

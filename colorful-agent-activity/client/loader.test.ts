import { describe, expect, it, vi } from "vitest";

/**
 * The loader is the only code Paseo compiles into the catalog entry, and its
 * whole job is deciding whether the cached payload can be reused. These tests
 * drive it with a fake payload, a fake host `require`, and a fake client, which
 * is exactly the shape Paseo provides at runtime:
 *
 *   (function(require) { … }).call(undefined, runtimeRequire) → { default }
 */

const CACHE_KEY = "__colorfulActivityClientPayload";

/** A stand-in for the built payload: a CJS factory with a default export. */
const PAYLOAD = `(function (require) {
  const host = require("@getpaseo/plugin/client");
  return {
    default: function contribute(client) {
      client.registered.push({ hasHostModule: Boolean(host), marker: "payload" });
      return function cleanup() {
        client.cleaned.push("payload");
      };
    },
  };
})`;

function makeClient(payload: { version: string; code: string } | Error) {
  return {
    registered: [] as unknown[],
    cleaned: [] as string[],
    rpc: vi.fn(async () => {
      if (payload instanceof Error) throw payload;
      return payload;
    }),
  };
}

async function loadModule() {
  vi.resetModules();
  // The loader is plain JS with no React Native imports, so it runs here as is.
  return import("../index.client");
}

const store = globalThis as typeof globalThis & {
  [CACHE_KEY]?: { version: string; code: string };
};

describe("client payload loader", () => {
  it("registers synchronously from a warm cache without any request", async () => {
    const { CLIENT_PAYLOAD_VERSION } = await import("../shared/client-payload");
    store[CACHE_KEY] = { version: CLIENT_PAYLOAD_VERSION, code: PAYLOAD };
    const { default: contribute } = await loadModule();
    const client = makeClient(new Error("should not be called"));

    const cleanup = contribute(client as never);

    expect(client.rpc).not.toHaveBeenCalled();
    // The payload reached a real host module through the loader's `require`.
    expect(client.registered).toEqual([{ hasHostModule: true, marker: "payload" }]);
    cleanup();
    expect(client.cleaned).toEqual(["payload"]);
    delete store[CACHE_KEY];
  });

  it("fetches, caches, and registers on a cold cache", async () => {
    const { CLIENT_PAYLOAD_VERSION } = await import("../shared/client-payload");
    delete store[CACHE_KEY];
    const { default: contribute } = await loadModule();
    const client = makeClient({ version: CLIENT_PAYLOAD_VERSION, code: PAYLOAD });

    const cleanup = contribute(client as never);
    await vi.waitFor(() => expect(client.registered).toHaveLength(1));

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(store[CACHE_KEY]).toEqual({ version: CLIENT_PAYLOAD_VERSION, code: PAYLOAD });
    cleanup();
    expect(client.cleaned).toEqual(["payload"]);
    delete store[CACHE_KEY];
  });

  it("re-fetches when the cached payload belongs to another version", async () => {
    const { CLIENT_PAYLOAD_VERSION } = await import("../shared/client-payload");
    store[CACHE_KEY] = { version: "stale", code: PAYLOAD };
    const { default: contribute } = await loadModule();
    const client = makeClient({ version: CLIENT_PAYLOAD_VERSION, code: PAYLOAD });

    contribute(client as never);
    await vi.waitFor(() => expect(client.registered).toHaveLength(1));
    expect(client.rpc).toHaveBeenCalledTimes(1);
    delete store[CACHE_KEY];
  });

  it("does not register a payload that arrives after the plugin was disposed", async () => {
    delete store[CACHE_KEY];
    const { default: contribute } = await loadModule();
    const client = makeClient({ version: "x", code: PAYLOAD });

    const cleanup = contribute(client as never);
    cleanup();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.registered).toEqual([]);
  });

  it("survives a failed fetch without throwing into Paseo", async () => {
    delete store[CACHE_KEY];
    const { default: contribute } = await loadModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient(new Error("offline"));

    const cleanup = contribute(client as never);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(client.registered).toEqual([]);
    cleanup();
    warn.mockRestore();
    delete store[CACHE_KEY];
  });

  it("reports a payload that is not executable instead of crashing the app", async () => {
    const { CLIENT_PAYLOAD_VERSION } = await import("../shared/client-payload");
    store[CACHE_KEY] = { version: CLIENT_PAYLOAD_VERSION, code: "not a factory" };
    const { default: contribute } = await loadModule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient(new Error("unused"));

    const cleanup = contribute(client as never);

    expect(warn).toHaveBeenCalled();
    expect(client.registered).toEqual([]);
    cleanup();
    warn.mockRestore();
    delete store[CACHE_KEY];
  });
});

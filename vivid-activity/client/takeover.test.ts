import { describe, expect, it, vi } from "vitest";
import { activitySettings, takeoverFromValues, type TakeoverScope } from "../shared/settings";
import { isSettingsChange, startTakeover, takeoverParts, type TakeoverHost, type TakeoverPart } from "./takeover";

/** A fake host that records the registered transformer groups, like Paseo's plugin registry. */
function fakeHost(reads: Array<TakeoverScope | null | Error> = []) {
  const registered = new Set<TakeoverPart>();
  const log: string[] = [];
  let changed: (() => void) | null = null;
  let pending: Array<(value: TakeoverScope | null) => void> = [];
  const host: TakeoverHost = {
    register(part) {
      if (registered.has(part)) throw new Error(`Duplicate timeline transformer: ${part}`);
      registered.add(part);
      log.push(`+${part}`);
      return () => {
        registered.delete(part);
        log.push(`-${part}`);
      };
    },
    read: vi.fn(() => {
      const next = reads.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<TakeoverScope | null>((resolve) => pending.push(resolve));
    }),
    watch(callback) {
      changed = callback;
      return () => {
        changed = null;
      };
    },
  };
  return {
    host,
    registered,
    log,
    fire: () => changed?.(),
    watching: () => changed !== null,
    resolvePending(value: TakeoverScope | null) {
      const queue = pending;
      pending = [];
      for (const resolve of queue) resolve(value);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("takeover scope", () => {
  it("maps each scope to the transformer groups it registers", () => {
    expect(takeoverParts("all")).toEqual(["reasoning", "tool-calls"]);
    expect(takeoverParts("reasoning")).toEqual(["reasoning"]);
    expect(takeoverParts("off")).toEqual([]);
  });

  it("defaults to taking over everything and stores the choice in the display settings", () => {
    expect(activitySettings.schema.parse({}).takeover).toBe("all");
    expect(takeoverFromValues({ takeover: "reasoning" })).toBe("reasoning");
    expect(takeoverFromValues(undefined)).toBe("all");
    expect(takeoverFromValues({ takeover: "sometimes" })).toBeNull();
  });

  it("registers the default groups synchronously, then follows the stored scope", async () => {
    const fake = fakeHost(["reasoning"]);
    const controller = startTakeover(fake.host);
    expect([...fake.registered]).toEqual(["reasoning", "tool-calls"]);
    await flush();
    expect(controller.scope()).toBe("reasoning");
    expect([...fake.registered]).toEqual(["reasoning"]);
    // Only the tool-call group was removed: the reasoning transformer kept its registration.
    expect(fake.log).toEqual(["+reasoning", "+tool-calls", "-tool-calls"]);
  });

  it("keeps rows native while the initial settings and catalog read is pending", async () => {
    const fake = fakeHost();
    const controller = startTakeover(fake.host, "off");
    expect([...fake.registered]).toEqual([]);
    fake.resolvePending("all");
    await flush();
    expect(controller.scope()).toBe("all");
    expect([...fake.registered]).toEqual(["reasoning", "tool-calls"]);
    controller.stop();
  });

  it("does not register late rows if the plugin stops while its initial read is pending", async () => {
    const fake = fakeHost();
    const controller = startTakeover(fake.host, "off");
    controller.stop();
    fake.resolvePending("all");
    await flush();
    expect([...fake.registered]).toEqual([]);
  });

  it("re-registers when a settings change arrives, and ignores unchanged scopes", async () => {
    const fake = fakeHost(["all", "off", "off", "all"]);
    startTakeover(fake.host);
    await flush();
    expect(fake.log).toEqual(["+reasoning", "+tool-calls"]);
    fake.fire();
    await flush();
    expect([...fake.registered]).toEqual([]);
    fake.fire();
    await flush();
    expect(fake.log).toEqual(["+reasoning", "+tool-calls", "-reasoning", "-tool-calls"]);
    fake.fire();
    await flush();
    expect([...fake.registered].sort()).toEqual(["reasoning", "tool-calls"]);
  });

  it("keeps the current scope when settings cannot be read", async () => {
    const fake = fakeHost([new Error("offline"), null]);
    const controller = startTakeover(fake.host, "reasoning");
    await flush();
    fake.fire();
    await flush();
    expect(controller.scope()).toBe("reasoning");
    expect([...fake.registered]).toEqual(["reasoning"]);
  });

  it("lets a just-saved scope win over a read that was already in flight", async () => {
    const fake = fakeHost();
    const controller = startTakeover(fake.host);
    controller.apply("off");
    expect([...fake.registered]).toEqual([]);
    fake.resolvePending("all");
    await flush();
    expect(controller.scope()).toBe("off");
    expect([...fake.registered]).toEqual([]);
  });

  it("stops following changes after cleanup and leaves removals to the host", async () => {
    const fake = fakeHost(["all"]);
    const controller = startTakeover(fake.host);
    await flush();
    controller.stop();
    expect(fake.watching()).toBe(false);
    controller.apply("off");
    expect([...fake.registered].sort()).toEqual(["reasoning", "tool-calls"]);
  });

  it("recognises settings-changed events for the display settings only", () => {
    const event = (payload: unknown) => ({ type: "status", payload });
    expect(isSettingsChange(event({ status: "plugin_settings_changed", pluginId: "vivid-activity", settingsId: "display" }), "display")).toBe(true);
    expect(isSettingsChange(event({ status: "plugin_settings_changed", pluginId: "x", settingsId: "other" }), "display")).toBe(false);
    expect(isSettingsChange(event({ status: "plugin_catalog_changed", pluginId: "vivid-activity" }), "display")).toBe(false);
    expect(isSettingsChange({ type: "agent_update", payload: {} }, "display")).toBe(false);
    expect(isSettingsChange(null, "display")).toBe(false);
  });
});

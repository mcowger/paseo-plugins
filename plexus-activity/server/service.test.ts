import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordPatch } from "../shared/row-model";
import type { plexusConfig } from "../shared/settings";
import type { KeyEntry, VerifyOutput } from "../shared/view";
import type { PlexusPort } from "./plexus-port";
import { type ActivityTimings, createActivityService } from "./service";

/**
 * The service is the riskiest part of the plugin: it owns a long-lived socket, a reconnect budget,
 * a settings subscription, and timers that must not outlive the plugin. These tests drive it with fake
 * timers and a scripted port instead of network I/O.
 */

const TIMINGS: Partial<ActivityTimings> = {
  heartbeatMs: 1_000,
  degradedAfterMs: 1_500,
  abortAfterMs: 4_000,
  degradedBackfillMs: 500,
  safetyBackfillMs: 60_000,
  keysRefreshMs: 60_000,
  connectBackoffMs: [1_000],
};

const READY: PluginSettingsState<typeof plexusConfig.schema> = {
  status: "ready",
  revision: "rev-1",
  values: { baseUrl: "http://plexus.test:4000", adminKey: "admin-secret", defaultScope: null },
};

function settingsStub(initial: PluginSettingsState<typeof plexusConfig.schema>) {
  let current = initial;
  const listeners = new Set<(state: PluginSettingsState<typeof plexusConfig.schema>) => void>();
  const settings = {
    read: async () => current,
    subscribe: (listener: (state: PluginSettingsState<typeof plexusConfig.schema>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as PluginSettings<typeof plexusConfig.schema>;

  return {
    settings,
    push(state: PluginSettingsState<typeof plexusConfig.schema>) {
      current = state;
      for (const listener of [...listeners]) listener(state);
    },
    listenerCount: () => listeners.size,
  };
}

interface FakePortState {
  openCalls: number;
  aborted: number;
  backfillCalls: number;
  keysCalls: number;
  verifyCalls: number;
  streamStatus: number;
  backfill: RecordPatch[];
  keys: KeyEntry[];
  keysStatus: number;
  verifyResult: VerifyOutput;
  emit(text: string): void;
  closeStream(): void;
}

function fakePort(): { port: PlexusPort; state: FakePortState } {
  const encoder = new TextEncoder();
  const emitters: ((chunk: Uint8Array) => void)[] = [];
  const closers: (() => void)[] = [];

  const state: FakePortState = {
    openCalls: 0,
    aborted: 0,
    backfillCalls: 0,
    keysCalls: 0,
    verifyCalls: 0,
    streamStatus: 200,
    backfill: [],
    keys: [],
    keysStatus: 200,
    verifyResult: { ok: true, role: "admin", keyName: null, error: null },
    emit(text) {
      emitters.at(-1)?.(encoder.encode(text));
    },
    closeStream() {
      closers.at(-1)?.();
    },
  };

  const port: PlexusPort = {
    async verify() {
      state.verifyCalls += 1;
      return state.verifyResult;
    },
    async listKeys() {
      state.keysCalls += 1;
      return { status: state.keysStatus, keys: state.keys };
    },
    async backfill() {
      state.backfillCalls += 1;
      return { status: 200, patches: state.backfill };
    },
    async openEvents(_baseUrl, _adminKey, signal, onChunk) {
      state.openCalls += 1;
      emitters.push(onChunk);
      const completion = new Promise<void>((resolve) => {
        closers.push(resolve);
        signal.addEventListener(
          "abort",
          () => {
            state.aborted += 1;
            resolve();
          },
          { once: true },
        );
      });
      return { status: state.streamStatus, completion };
    },
  };

  return { port, state };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

describe("createActivityService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function serviceWith(
    initial: PluginSettingsState<typeof plexusConfig.schema>,
    configure?: (state: FakePortState) => void,
  ) {
    const { port, state } = fakePort();
    configure?.(state);
    const settings = settingsStub(initial);
    const service = createActivityService({
      settings: settings.settings,
      port,
      timings: TIMINGS,
      maxRows: 10,
    });
    service.start();
    return { service, state, settings };
  }

  it("stays unconfigured without an admin key and never connects", async () => {
    const { service, state } = serviceWith({
      status: "ready",
      revision: "rev-0",
      values: { baseUrl: "http://plexus.test:4000", adminKey: "", defaultScope: null },
    });
    await settle();

    const snapshot = service.snapshot({ scope: null, since: null });
    expect(snapshot.status).toMatchObject({ configured: false, connection: "unconfigured" });
    expect(snapshot.status.lastError).toContain("admin key");
    expect(state.openCalls).toBe(0);

    await service.stop();
  });

  it("connects, backfills, and folds stream frames into rows", async () => {
    const { service, state } = serviceWith(READY, (seed) => {
      seed.backfill = [{ requestId: "history", startTime: 1, selectedModelName: "old-model" }];
    });
    await settle();

    expect(state.openCalls).toBe(1);
    expect(state.backfillCalls).toBe(1);
    expect(service.snapshot({ scope: null, since: null }).status.connection).toBe("live");
    expect(service.snapshot({ scope: null, since: null }).rows.map((row) => row.requestId)).toEqual(
      ["history"],
    );

    state.emit(
      frame("started", {
        requestId: "live-1",
        startTime: Date.now(),
        responseStatus: "pending",
        apiKey: "team-a",
        incomingApiType: "chat",
        outgoingApiType: "openai-chat",
        isStreamed: true,
      }),
    );

    const snapshot = service.snapshot({ scope: null, since: null });
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows[0]?.requestId).toBe("live-1");

    state.emit(
      frame("completed", {
        requestId: "live-1",
        responseStatus: "success",
        tokensInput: 100,
        tokensOutput: 20,
        costTotal: 0.001,
        durationMs: 2_000,
      }),
    );

    const [row] = service.snapshot({ scope: null, since: null }).rows;
    expect(row?.status).toBe("success");
    expect(row?.tokens.output).toBe(20);
    expect(row?.costTotal).toBe(0.001);

    await service.stop();
  });

  it("merges sparse updated events without dropping earlier fields", async () => {
    const { service, state } = serviceWith(READY);
    await settle();

    state.emit(
      frame("started", {
        requestId: "req",
        startTime: Date.now(),
        responseStatus: "pending",
        apiKey: "team-a",
      }),
    );
    state.emit(frame("updated", { requestId: "req", selectedModelName: "gpt-5.4" }));

    const [row] = service.snapshot({ scope: null, since: null }).rows;
    expect(row?.modelSlug).toBe("gpt-5.4");
    expect(row?.status).toBe("pending");

    await service.stop();
  });

  it("ignores ping frames and unknown event types", async () => {
    const { service, state } = serviceWith(READY);
    await settle();

    state.emit("event: ping\ndata: pong\n\n");
    state.emit(frame("mystery", { requestId: "x" }));

    expect(service.snapshot({ scope: null, since: null }).rows).toEqual([]);

    await service.stop();
  });

  it("halts on 401 instead of retrying a rejected key", async () => {
    const { service, state } = serviceWith(READY);
    state.streamStatus = 401;
    await settle();

    expect(service.snapshot({ scope: null, since: null }).status.connection).toBe("unauthorized");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.openCalls).toBeGreaterThanOrEqual(1);

    const callsAfterHalt = state.openCalls;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.openCalls).toBe(callsAfterHalt);

    await service.stop();
  });

  it("reconnects with backoff when the stream closes", async () => {
    const { service, state } = serviceWith(READY);
    await settle();
    expect(state.openCalls).toBe(1);

    state.closeStream();
    await settle();
    expect(service.snapshot({ scope: null, since: null }).status.connection).toBe("retrying");

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(state.openCalls).toBe(2);

    await service.stop();
  });

  it("switches to degraded polling when the stream goes quiet", async () => {
    const { service, state } = serviceWith(READY);
    await settle();
    const backfillsAfterConnect = state.backfillCalls;

    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(service.snapshot({ scope: null, since: null }).status.connection).toBe("degraded");
    expect(state.backfillCalls).toBeGreaterThan(backfillsAfterConnect);

    await service.stop();
  });

  it("aborts and reconnects when the stream is silent for too long", async () => {
    const { service, state } = serviceWith(READY);
    await settle();
    expect(state.openCalls).toBe(1);

    // Aborts at the 4s idle threshold, then waits out the 1s backoff before reconnecting.
    await vi.advanceTimersByTimeAsync(4_100);
    await settle();

    expect(state.aborted).toBeGreaterThanOrEqual(1);
    expect(service.snapshot({ scope: null, since: null }).status.connection).toBe("retrying");

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(state.openCalls).toBe(2);

    await service.stop();
  });

  it("reconnects and resets the store when the settings change", async () => {
    const { service, state, settings } = serviceWith(READY);
    await settle();
    state.emit(
      frame("started", { requestId: "req", startTime: Date.now(), responseStatus: "pending" }),
    );
    expect(service.snapshot({ scope: null, since: null }).rows).toHaveLength(1);

    settings.push({
      status: "ready",
      revision: "rev-2",
      values: { baseUrl: "http://plexus.test:4000", adminKey: "other-secret", defaultScope: null },
    });
    await settle();

    expect(state.openCalls).toBe(2);
    expect(service.snapshot({ scope: null, since: null }).rows).toEqual([]);

    await service.stop();
  });

  it("exposes key names without secrets and reports admin role", async () => {
    const { service, state } = serviceWith(READY);
    state.keys = [
      { name: "team-a", disabled: false },
      { name: "team-b", disabled: true },
    ];
    await settle();

    const keys = await service.keys({});
    expect(keys).toEqual({
      status: "ok",
      role: "admin",
      keys: [
        { name: "team-a", disabled: false },
        { name: "team-b", disabled: true },
      ],
    });

    await service.stop();
  });

  it("re-reads the key list when the panel asks for a refresh", async () => {
    const { service, state } = serviceWith(READY);
    await settle();
    expect((await service.keys({})).keys).toEqual([]);

    state.keys = [{ name: "fresh", disabled: false }];
    await vi.advanceTimersByTimeAsync(2_500);
    const refreshed = await service.keys({ refresh: true });
    expect(refreshed.keys).toEqual([{ name: "fresh", disabled: false }]);

    await service.stop();
  });

  it("reports an unavailable key list when Plexus refuses it", async () => {
    const { service, state } = serviceWith(READY);
    state.keysStatus = 403;
    state.verifyResult = { ok: true, role: "limited", keyName: "team-a", error: null };
    await settle();

    expect(await service.keys({})).toMatchObject({
      status: "unauthorized",
      role: "limited",
      keys: [],
    });

    await service.stop();
  });

  it("verifies a candidate credential without touching the live connection", async () => {
    const { service, state } = serviceWith(READY);
    await settle();

    state.verifyResult = {
      ok: false,
      role: null,
      keyName: null,
      error: "Plexus rejected that admin key (HTTP 401).",
    };

    const result = await service.verify({
      baseUrl: "http://plexus.test:4000/",
      adminKey: "candidate",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
    expect(service.snapshot({ scope: null, since: null }).status.connection).toBe("live");

    const invalidUrl = await service.verify({ baseUrl: "not-a-url", adminKey: "candidate" });
    expect(invalidUrl.ok).toBe(false);

    await service.stop();
  });

  it("stops the stream, timers, and settings subscription on cleanup", async () => {
    const { service, state, settings } = serviceWith(READY);
    await settle();
    expect(settings.listenerCount()).toBe(1);

    await service.stop();
    expect(state.aborted).toBeGreaterThanOrEqual(1);
    expect(settings.listenerCount()).toBe(0);

    const callsAfterStop = state.openCalls;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.openCalls).toBe(callsAfterStop);

    // Idempotent shutdown.
    await service.stop();
  });

  it("reports invalid settings without connecting", async () => {
    const { service, state } = serviceWith({
      status: "invalid",
      revision: "rev-bad",
      error: "stored values do not match the schema",
    });
    await settle();

    const snapshot = service.snapshot({ scope: null, since: null });
    expect(snapshot.status.connection).toBe("error");
    expect(snapshot.status.lastError).toContain("schema");
    expect(state.openCalls).toBe(0);

    await service.stop();
  });

  it("keeps rows for a scope and drops them when the scope changes", async () => {
    const { service, state } = serviceWith(READY);
    await settle();
    state.emit(
      frame("started", {
        requestId: "a",
        startTime: Date.now(),
        responseStatus: "pending",
        apiKey: "team-a",
      }),
    );
    state.emit(
      frame("started", {
        requestId: "b",
        startTime: Date.now() + 1,
        responseStatus: "pending",
        apiKey: "team-b",
      }),
    );

    expect(service.snapshot({ scope: "team-a", since: null }).rows).toHaveLength(1);
    expect(service.snapshot({ scope: "team-b", since: null }).rows).toHaveLength(1);
    expect(service.snapshot({ scope: "nobody", since: null }).rows).toHaveLength(0);

    await service.stop();
  });
});

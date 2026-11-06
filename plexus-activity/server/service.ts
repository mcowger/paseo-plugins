import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { normalizeBaseUrl, type plexusConfig, resolveConfig } from "../shared/settings";
import {
  type ConnectionState,
  type KeyEntry,
  type KeysInput,
  type KeysOutput,
  keysOutputSchema,
  type SnapshotInput,
  type SnapshotOutput,
  snapshotOutputSchema,
  type VerifyInput,
  type VerifyOutput,
  verifyOutputSchema,
} from "../shared/view";
import { createLiveStore, DEFAULT_MAX_ROWS } from "./live-store";
import type { PlexusPort } from "./plexus-port";
import { toProgressSample, toRecordPatch } from "./records";
import { createSseParser, type SseFrame } from "./sse";

/**
 * Owns the single Plexus SSE connection and the store the panel polls.
 *
 * Paseo 0.12.0 has no server-to-client push channel, so the server keeps the connection warm and the
 * panel asks for deltas. Startup is the body of `contribute(server)`; shutdown is the returned
 * cleanup, so `stop()` must release every timer and socket.
 */

export interface ActivityTimings {
  /** Heartbeat tick that checks idle time and schedules backfills. */
  readonly heartbeatMs: number;
  /** No bytes for this long means a proxy is buffering: switch to REST polling. */
  readonly degradedAfterMs: number;
  /** No bytes for this long means the connection is dead: abort and reconnect. */
  readonly abortAfterMs: number;
  readonly degradedBackfillMs: number;
  readonly safetyBackfillMs: number;
  readonly keysRefreshMs: number;
  readonly connectBackoffMs: readonly number[];
}

const DEFAULT_TIMINGS: ActivityTimings = {
  heartbeatMs: 5_000,
  degradedAfterMs: 15_000,
  abortAfterMs: 45_000,
  degradedBackfillMs: 10_000,
  safetyBackfillMs: 60_000,
  keysRefreshMs: 300_000,
  connectBackoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
};

const BACKFILL_LIMIT = 100;

export interface ActivityServiceOptions {
  readonly settings: PluginSettings<typeof plexusConfig.schema>;
  readonly port: PlexusPort;
  readonly clock?: () => number;
  readonly maxRows?: number;
  readonly backfillLimit?: number;
  readonly timings?: Partial<ActivityTimings>;
  readonly log?: (message: string) => void;
}

export interface ActivityService {
  start(): void;
  stop(): Promise<void>;
  snapshot(input: SnapshotInput): SnapshotOutput;
  keys(input: KeysInput): Promise<KeysOutput>;
  verify(input: VerifyInput): Promise<VerifyOutput>;
}

interface ResolvedConnection {
  readonly baseUrl: string;
  readonly adminKey: string;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Never let a header value or URL credential reach the panel.
  return message.split("\n")[0]?.trim().slice(0, 200) || "Plexus request failed";
}

function parseFrameData(data: string): unknown {
  if (data === "" || data === "pong") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

export function createActivityService(options: ActivityServiceOptions): ActivityService {
  const clock = options.clock ?? Date.now;
  const log = options.log ?? (() => {});
  const timings: ActivityTimings = { ...DEFAULT_TIMINGS, ...options.timings };
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const backfillLimit = options.backfillLimit ?? BACKFILL_LIMIT;

  let store = createLiveStore({ maxRows, clock });

  let config: ResolvedConnection | null = null;
  let connection: ConnectionState = "unconfigured";
  let lastError: string | null = null;
  let lastEventAt: number | null = null;
  let retryAt: number | null = null;
  let role: "admin" | "limited" | null = null;
  let keys: KeyEntry[] = [];
  let keysStatus: "ok" | "unavailable" | "unauthorized" = "unavailable";

  let generation = 0;
  let halted = false;
  let stopped = false;
  let attemptController: AbortController | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastByteAt = 0;
  let lastBackfillAt = 0;
  let lastKeysAt = 0;
  let keysInFlight = false;
  let backfillInFlight = false;
  let unsubscribeSettings: (() => void | Promise<void>) | null = null;

  const pendingSleeps = new Map<ReturnType<typeof setTimeout>, () => void>();

  function alive(target: number): boolean {
    return !stopped && !halted && generation === target;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSleeps.delete(timer);
        resolve();
      }, ms);
      pendingSleeps.set(timer, resolve);
    });
  }

  function clearSleeps(): void {
    for (const [timer, resolve] of pendingSleeps) {
      clearTimeout(timer);
      resolve();
    }
    pendingSleeps.clear();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function setConnection(next: ConnectionState): void {
    connection = next;
    if (next !== "retrying") retryAt = null;
  }

  function handleFrame(frame: SseFrame): void {
    if (frame.event === "ping") return;

    const payload = parseFrameData(frame.data);
    if (payload === null) return;
    lastEventAt = clock();

    if (frame.event === "progress") {
      const update = toProgressSample(payload);
      if (update !== null) store.applyProgress(update.requestId, update.sample);
      return;
    }

    if (frame.event === "started" || frame.event === "updated" || frame.event === "completed") {
      const patch = toRecordPatch(payload);
      if (patch !== null) store.applyPatch(patch);
    }
    // Unknown event types are ignored, per the Plexus event-stream contract.
  }

  async function refreshKeys(signal: AbortSignal | null): Promise<void> {
    const current = config;
    if (current === null || keysInFlight) return;

    keysInFlight = true;
    lastKeysAt = clock();
    try {
      const result = await options.port.listKeys(
        current.baseUrl,
        current.adminKey,
        signal ?? undefined,
      );
      if (result.status === 200) {
        keys = result.keys;
        keysStatus = "ok";
      } else if (result.status === 401 || result.status === 403) {
        keysStatus = "unauthorized";
      } else {
        keysStatus = "unavailable";
      }
    } catch {
      keysStatus = "unavailable";
    } finally {
      keysInFlight = false;
    }
  }

  async function runAuxiliary(target: number, signal: AbortSignal): Promise<void> {
    const current = config;
    if (current === null || backfillInFlight) return;

    backfillInFlight = true;
    lastBackfillAt = clock();
    try {
      const result = await options.port.backfill(
        current.baseUrl,
        current.adminKey,
        backfillLimit,
        signal,
      );
      if (!alive(target)) return;
      if (result.status === 401 || result.status === 403) {
        halted = true;
        setConnection("unauthorized");
        attemptController?.abort();
        return;
      }
      if (result.status === 200) store.applyPatches(result.patches);
    } catch {
      // A failed backfill is not fatal: the stream may already be delivering rows.
    } finally {
      backfillInFlight = false;
    }

    if (!alive(target)) return;
    if (clock() - lastKeysAt >= timings.keysRefreshMs) {
      await refreshKeys(signal);
      if (!alive(target)) return;
    }

    if (role === null) {
      const verified = await options.port.verify(current.baseUrl, current.adminKey, signal);
      if (!alive(target)) return;
      role = verified.role;
    }
  }

  function startHeartbeat(target: number, signal: AbortSignal): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!alive(target)) {
        stopHeartbeat();
        return;
      }

      const now = clock();
      const idleFor = now - lastByteAt;

      if (idleFor >= timings.abortAfterMs) {
        stopHeartbeat();
        attemptController?.abort();
        return;
      }

      if (idleFor >= timings.degradedAfterMs) {
        if (connection !== "degraded" && connection !== "unauthorized") {
          setConnection("degraded");
        }
        if (now - lastBackfillAt >= timings.degradedBackfillMs) {
          void runAuxiliary(target, signal);
        }
        return;
      }

      if (now - lastBackfillAt >= timings.safetyBackfillMs) {
        void runAuxiliary(target, signal);
      }
    }, timings.heartbeatMs);
  }

  async function runConnection(target: number): Promise<void> {
    let attempt = 0;

    while (alive(target)) {
      const current = config;
      if (current === null) return;

      const controller = new AbortController();
      attemptController = controller;
      lastByteAt = clock();
      setConnection(attempt === 0 ? "connecting" : "retrying");

      try {
        const parser = createSseParser(handleFrame);
        const handle = await options.port.openEvents(
          current.baseUrl,
          current.adminKey,
          controller.signal,
          (chunk) => {
            lastByteAt = clock();
            parser.push(chunk);
          },
        );

        if (handle.status !== 200) {
          if (handle.status === 401 || handle.status === 403) {
            halted = true;
            setConnection("unauthorized");
            lastError = "Plexus rejected the admin key.";
            return;
          }
          lastError = `Plexus returned HTTP ${handle.status}.`;
        } else {
          attempt = 0;
          lastError = null;
          setConnection("live");
          void runAuxiliary(target, controller.signal);
          startHeartbeat(target, controller.signal);
          await handle.completion;
          stopHeartbeat();
          if (!alive(target)) return;
          lastError = "Plexus closed the event stream.";
        }
      } catch (error) {
        if (!alive(target)) return;
        lastError = errorMessage(error);
      } finally {
        stopHeartbeat();
        attemptController = null;
      }

      if (!alive(target)) return;

      const backoff =
        timings.connectBackoffMs[Math.min(attempt, timings.connectBackoffMs.length - 1)] ?? 1_000;
      attempt += 1;
      setConnection("retrying");
      retryAt = clock() + backoff;
      log(`Plexus event stream unavailable (${lastError ?? "unknown"}); retrying in ${backoff}ms`);
      await sleep(backoff);
      if (!alive(target)) return;
      retryAt = null;
    }
  }

  function resetForConfig(): void {
    generation += 1;
    halted = false;
    attemptController?.abort();
    attemptController = null;
    stopHeartbeat();
    clearSleeps();
  }

  function applySettingsState(state: PluginSettingsState<typeof plexusConfig.schema>): void {
    if (stopped) return;

    if (state.status !== "ready") {
      resetForConfig();
      config = null;
      role = null;
      keys = [];
      keysStatus = "unavailable";
      lastError = state.error;
      setConnection("error");
      return;
    }

    const resolved = resolveConfig(state.values);
    if (!resolved.ok) {
      resetForConfig();
      config = null;
      role = null;
      keys = [];
      keysStatus = "unavailable";
      lastError = resolved.error;
      setConnection(state.values.adminKey ? "error" : "unconfigured");
      return;
    }

    if (
      config !== null &&
      config.baseUrl === resolved.baseUrl &&
      config.adminKey === resolved.adminKey
    ) {
      return;
    }

    resetForConfig();
    config = { baseUrl: resolved.baseUrl, adminKey: resolved.adminKey };
    role = null;
    keys = [];
    keysStatus = "unavailable";
    lastError = null;
    lastEventAt = null;
    lastBackfillAt = 0;
    lastKeysAt = 0;
    store = createLiveStore({ maxRows, clock });
    const target = generation;
    void runConnection(target).catch((error) => {
      if (!alive(target)) return;
      setConnection("error");
      lastError = errorMessage(error);
    });
  }

  return {
    start() {
      void options.settings
        .read()
        .then((state) => applySettingsState(state))
        .catch((error) => {
          if (stopped) return;
          setConnection("error");
          lastError = errorMessage(error);
        });

      const cleanup = options.settings.subscribe((state) => applySettingsState(state));
      unsubscribeSettings = typeof cleanup === "function" ? cleanup : null;
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      halted = true;

      if (unsubscribeSettings !== null) {
        const unsubscribe = unsubscribeSettings;
        unsubscribeSettings = null;
        await Promise.resolve(unsubscribe());
      }

      attemptController?.abort();
      attemptController = null;
      stopHeartbeat();
      clearSleeps();
    },

    snapshot(input) {
      const result = store.snapshot({ scope: input.scope ?? null, since: input.since ?? null });
      return snapshotOutputSchema.parse({
        status: {
          configured: config !== null,
          connection,
          lastEventAt,
          lastError,
          retryInMs: retryAt === null ? null : Math.max(0, retryAt - clock()),
        },
        cursor: result.cursor,
        serverNow: result.serverNow,
        reset: result.reset,
        rows: result.rows,
      });
    },

    async keys(input) {
      if (input.refresh === true && clock() - lastKeysAt >= 2_000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          await refreshKeys(controller.signal);
        } finally {
          clearTimeout(timer);
        }
      }
      return keysOutputSchema.parse({ status: keysStatus, role, keys });
    },

    async verify(input) {
      const normalized = normalizeBaseUrl(input.baseUrl);
      if (!normalized.ok) {
        return verifyOutputSchema.parse({
          ok: false,
          role: null,
          keyName: null,
          error: normalized.error,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const result = await options.port.verify(
          normalized.baseUrl,
          input.adminKey,
          controller.signal,
        );
        return verifyOutputSchema.parse(result);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

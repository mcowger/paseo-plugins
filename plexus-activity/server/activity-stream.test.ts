import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityUpdate, ConnectionStatus, SnapshotInput } from "../shared/view";
import { ACTIVITY_PUSH_DEBOUNCE_MS, streamActivity } from "./activity-stream";
import type { ActivityListener, ActivityService } from "./service";

const IDLE: ConnectionStatus = {
  configured: true,
  connection: "live",
  lastEventAt: null,
  lastError: null,
  retryInMs: null,
};

function fakeService() {
  const listeners = new Set<ActivityListener>();
  let cursor = 0;
  const snapshot = vi.fn(
    (input: SnapshotInput): ActivityUpdate => ({
      status: IDLE,
      cursor,
      serverNow: 0,
      reset: input.since === null,
      rows: [],
    }),
  );
  const service: Pick<ActivityService, "snapshot" | "subscribe"> = {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    service,
    snapshot,
    listenerCount: () => listeners.size,
    change(reset: boolean, nextCursor: number) {
      cursor = nextCursor;
      for (const listener of [...listeners]) listener(reset);
    },
  };
}

function fakeContext() {
  const controller = new AbortController();
  const push = vi.fn(async (_event: ActivityUpdate) => {});
  const context = {
    push,
    signal: controller.signal,
  } as unknown as PluginSubscriptionContext<ActivityUpdate>;
  return { context, push, abort: () => controller.abort() };
}

describe("streamActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes a reset snapshot immediately on subscribe", () => {
    const { service } = fakeService();
    const { context, push } = fakeContext();

    streamActivity(service, { scope: null, epoch: 0 }, context);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0].reset).toBe(true);
  });

  it("coalesces a burst of changes into one delta after the debounce window", () => {
    const fake = fakeService();
    const { context, push } = fakeContext();
    streamActivity(fake.service, { scope: null, epoch: 0 }, context);

    fake.change(false, 1);
    fake.change(false, 2);
    fake.change(false, 3);
    expect(push).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ACTIVITY_PUSH_DEBOUNCE_MS);

    expect(push).toHaveBeenCalledTimes(2);
    expect(fake.snapshot).toHaveBeenLastCalledWith({ scope: null, since: 0 });
  });

  it("unsubscribes and drops a pending push when the subscriber aborts", () => {
    const fake = fakeService();
    const { context, push, abort } = fakeContext();
    streamActivity(fake.service, { scope: null, epoch: 0 }, context);

    fake.change(false, 1);
    abort();
    vi.advanceTimersByTime(ACTIVITY_PUSH_DEBOUNCE_MS);
    fake.change(false, 2);
    vi.advanceTimersByTime(ACTIVITY_PUSH_DEBOUNCE_MS);

    expect(fake.listenerCount()).toBe(0);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe or push when the subscriber is already gone", () => {
    const fake = fakeService();
    const { context, push, abort } = fakeContext();
    abort();
    streamActivity(fake.service, { scope: null, epoch: 0 }, context);
    fake.change(false, 1);
    vi.advanceTimersByTime(ACTIVITY_PUSH_DEBOUNCE_MS);
    expect(fake.listenerCount()).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });
});

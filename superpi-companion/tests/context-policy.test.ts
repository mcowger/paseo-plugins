import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextPolicyConsumer, CONTEXT_POLICY_REQUEST, CONTEXT_POLICY_SNAPSHOT } from "../src/context-policy.ts";
import { createFakePi } from "./harness.ts";

const publisherId = "00000000-0000-4000-8000-000000000001";
const model = { provider: "plexus", id: "model" };
const policy = { provider: "plexus", modelId: "model", maxContextTokens: 1_000_000, shortContextBudgetTokens: 200_000 };
const snapshot = (overrides = {}) => ({ version: 1, publisherId, revision: 1, status: "ready", policies: [policy], ...overrides });
afterEach(() => vi.useRealTimers());

describe("policy event consumer", () => {
  it("subscribes before an immediate correlated response and never fetches", async () => {
    const pi = createFakePi({ policies: [policy] });
    const change = vi.fn();
    const consumer = createContextPolicyConsumer(pi.api.events, change);
    await consumer.request();
    expect(consumer.policy(model)).toEqual(policy);
    expect(consumer.policy({ ...model, provider: "other" })).toBeUndefined();
    expect(change).toHaveBeenCalledOnce();
    await consumer.request();
    expect(change).toHaveBeenCalledOnce();
    consumer.close();
    expect(pi.eventHandlers.get(CONTEXT_POLICY_SNAPSHOT)?.size).toBe(0);
  });

  it("replaces policies, rejects stale/invalid frames and distinguishes unavailable from empty ready", async () => {
    const pi = createFakePi({ policies: [policy] });
    const consumer = createContextPolicyConsumer(pi.api.events, vi.fn());
    await consumer.request();
    for (const invalid of [snapshot({ revision: 0 }), snapshot({ revision: 2, policies: [{ ...policy, shortContextBudgetTokens: 2_000_000 }] }), snapshot({ revision: 2, policies: [policy, policy] }), snapshot({ revision: 2, status: "loading" }), snapshot({ version: 2 }), snapshot({ revision: 2, requestId: "wrong" }), snapshot({ revision: 2, reason: "x".repeat(1024 * 1024) })]) {
      pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, invalid);
      expect(consumer.policy(model)).toEqual(policy);
    }
    pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, snapshot({ revision: 2, policies: [] }));
    expect(consumer.policy(model)).toBeUndefined();
    pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, snapshot());
    expect(consumer.policy(model)).toBeUndefined();
    pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, snapshot({ revision: 3 }));
    expect(consumer.policy(model)).toEqual(policy);
    pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, snapshot({ revision: 4, status: "unavailable", policies: [] }));
    expect(consumer.policy(model)).toBeUndefined();
    consumer.close();
  });

  it("accepts a replacement publisher only after correlation and ignores the retired publisher", async () => {
    const pi = createFakePi({ policies: [policy] });
    const consumer = createContextPolicyConsumer(pi.api.events, vi.fn());
    await consumer.request();
    const nextPublisher = "00000000-0000-4000-8000-000000000002";
    pi.eventHandlers.get(CONTEXT_POLICY_REQUEST)?.clear();
    pi.api.events.on(CONTEXT_POLICY_REQUEST, (request) => {
      pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, snapshot({ publisherId: nextPublisher, requestId: (request as { requestId: string }).requestId, policies: [] }));
    });
    pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, snapshot({ publisherId: nextPublisher }));
    expect(consumer.policy(model)).toBeUndefined();
    pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, snapshot({ revision: 999 }));
    expect(consumer.policy(model)).toBeUndefined();
    consumer.close();
  });

  it("times out absent publishers after one second and cancels pending timers on shutdown", async () => {
    vi.useFakeTimers();
    const pi = createFakePi({ noPolicyPublisher: true });
    const consumer = createContextPolicyConsumer(pi.api.events, vi.fn());
    const pending = consumer.request();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(consumer.policy(model)).toBeUndefined();
    const next = consumer.request();
    consumer.close();
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { createServiceTiersConsumer, SERVICE_TIERS_REQUEST, SERVICE_TIERS_SNAPSHOT } from "../src/service-tiers.ts";
import { createCompanion } from "../src/companion.ts";
import { encodeRequest, STATE_NOTIFY_PREFIX } from "../src/protocol.ts";
import { createFakeContext, createFakePi, readReply } from "./harness.ts";

const model = { provider: "plexus", id: "luna", api: "openai-completions", contextWindow: 1000000 };
const policy = { provider: "plexus", modelId: "luna", serviceTiers: ["standard", "flex", "priority"] };
const frame = (overrides = {}) => ({ version: 1, publisherId: "00000000-0000-4000-8000-000000000001", revision: 1, status: "ready", policies: [policy], ...overrides });
const configure = (tier: string) => encodeRequest({ version: 1, sessionKey: "key", requestId: "cfg", operation: "configure", data: { tier } });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

it("requests advertised tiers synchronously with exact identity and rejects invalid/stale snapshots", async () => {
  const pi = createFakePi({ tierPolicies: [policy] });
  const change = vi.fn();
  const tiers = createServiceTiersConsumer(pi.api.events, change);
  await tiers.request();
  expect(tiers.policy(model)).toEqual(policy);
  expect(tiers.policy({ ...model, provider: "other" })).toBeUndefined();
  for (const invalid of [frame({ revision: 0 }), frame({ revision: 2, requestId: "unrelated" }), frame({ revision: 2, policies: [policy, policy] }), frame({ revision: 2, policies: [{ ...policy, serviceTiers: [] }] }), frame({ revision: 2, policies: [{ ...policy, serviceTiers: ["priority", "priority"] }] }), frame({ revision: 2, policies: [{ ...policy, serviceTiers: [""] }] }), frame({ revision: 2, reason: "x".repeat(1024 * 1024) }), frame({ revision: 2, status: "loading" })]) {
    pi.emitEvent(SERVICE_TIERS_SNAPSHOT, invalid);
    expect(tiers.policy(model)).toEqual(policy);
  }
  pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame({ revision: 2, policies: [] }));
  expect(tiers.policy(model)).toBeUndefined();
  pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame());
  expect(tiers.policy(model)).toBeUndefined();
  tiers.close();
  expect(pi.eventHandlers.get(SERVICE_TIERS_SNAPSHOT)?.size).toBe(0);
});

it("does not select a premium tier without explicit user intent", async () => {
  const pi = createFakePi({ registry: [model], tierPolicies: [{ ...policy, serviceTiers: ["priority", "flex"] }] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx } = createFakeContext({ pi, model });
  await companion.restore(ctx);
  expect(companion.buildState(ctx).settings.tier).toBe("default");
  expect(pi.handlers.get("before_provider_request")?.[0]?.({ payload: {} }, ctx)).toBeUndefined();
  await companion.handleArgs(configure("flex"), ctx);
  expect(pi.handlers.get("before_provider_request")?.[0]?.({ payload: {} }, ctx)).toEqual({ service_tier: "flex" });
});

it("retains chosen tier across unsupported models and persists intent during metadata loss", async () => {
  const next = { ...model, id: "next" };
  const pi = createFakePi({ registry: [model, next], tierPolicies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx } = createFakeContext({ pi, model });
  await companion.restore(ctx);
  await companion.handleArgs(configure("flex"), ctx);
  pi.sessionModel = next;
  await pi.handlers.get("model_select")?.[0]?.({ model: next }, ctx);
  expect(companion.buildState(ctx).settings.tier).toBe("default");
  expect(pi.entries.at(-1)?.data).toMatchObject({ tier: "flex" });
  pi.sessionModel = model;
  await pi.handlers.get("model_select")?.[0]?.({ model }, ctx);
  expect(companion.buildState(ctx).settings.tier).toBe("flex");
  pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame({ revision: 2, status: "unavailable", policies: [] }));
  await flush();
  expect(companion.buildState(ctx).settings.tier).toBe("default");
  expect(pi.entries.at(-1)?.data).toMatchObject({ tier: "flex" });
  pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame({ revision: 3 }));
  await flush();
  expect(companion.buildState(ctx).settings.tier).toBe("flex");
});

it("allows tier-only changes independently of context model application", async () => {
  const pi = createFakePi({ registry: [model], tierPolicies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx, notifies } = createFakeContext({ pi, model });
  await companion.restore(ctx);
  pi.setModelRefuses = true;
  pi.sessionModel = { ...model, contextWindow: 0 };
  await companion.handleArgs(configure("priority"), ctx);
  expect(readReply(notifies).ok).toBe(true);
  expect(companion.buildState(ctx).settings.tier).toBe("priority");
});

it("times out missing publishers and cleans pending requests on shutdown", async () => {
  vi.useFakeTimers();
  const pi = createFakePi({ noTierPublisher: true });
  const consumer = createServiceTiersConsumer(pi.api.events, vi.fn());
  const pending = consumer.request();
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(consumer.policy(model)).toBeUndefined();
  const next = consumer.request();
  consumer.close();
  await next;
  expect(vi.getTimerCount()).toBe(0);
});

it("selects only discovered tiers, injects exact payload values, and migrates legacy fast", async () => {
  const pi = createFakePi({ registry: [model], tierPolicies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx, notifies } = createFakeContext({ pi, model, branch: [{ type: "custom", customType: "superpi-controls", data: { version: 1, tier: "fast", longContext: false, timestamp: 1 } }] });
  await companion.restore(ctx);
  expect(companion.buildState(ctx)).toMatchObject({ tiers: policy.serviceTiers, settings: { tier: "priority" }, tierApplicable: true });
  expect(pi.handlers.get("before_provider_request")?.[0]?.({ payload: { model: "luna" } }, ctx)).toEqual({ model: "luna", service_tier: "priority" });
  for (const tier of ["turbo", "ultrafast"]) {
    await companion.handleArgs(configure(tier), ctx);
    expect(readReply(notifies).ok).toBe(false);
    expect(companion.buildState(ctx).settings.tier).toBe("priority");
  }
  await companion.handleArgs(configure("flex"), ctx);
  expect(companion.buildState(ctx).settings.tier).toBe("flex");
  expect(pi.handlers.get("before_provider_request")?.[0]?.({ payload: {} }, ctx)).toEqual({ service_tier: "flex" });
  pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame({ revision: 2, policies: [{ ...policy, serviceTiers: ["standard", "priority"] }] }));
  await flush();
  expect(companion.buildState(ctx).settings.tier).toBe("standard");
  expect(notifies.at(-1)?.message.startsWith(STATE_NOTIFY_PREFIX)).toBe(true);
  pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame({ revision: 3, policies: [] }));
  await flush();
  expect(companion.buildState(ctx)).toMatchObject({ tiers: [], settings: { tier: "default" }, tierApplicable: false });
  expect(pi.handlers.get("before_provider_request")?.[0]?.({ payload: {} }, ctx)).toBeUndefined();
  pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
  expect(pi.eventHandlers.get(SERVICE_TIERS_SNAPSHOT)?.size).toBe(0);
});

it("resets unsupported selections on model switches and does not inject in child sessions", async () => {
  const next = { ...model, id: "next" };
  for (const origin of ["root", "child"] as const) {
    const pi = createFakePi({ registry: [model, next], tierPolicies: [policy, { ...policy, modelId: "next", serviceTiers: ["auto", "priority"] }] });
    const companion = createCompanion(pi.api, { origin, sessionKey: "key" });
    const { ctx } = createFakeContext({ pi, model });
    await companion.restore(ctx);
    if (origin === "root") {
      await companion.handleArgs(configure("flex"), ctx);
      pi.sessionModel = next;
      await pi.handlers.get("model_select")?.[0]?.({ model: next }, ctx);
      expect(companion.buildState(ctx)).toMatchObject({ tiers: ["auto", "priority"], settings: { tier: "auto" } });
    } else expect(pi.handlers.get("before_provider_request")?.[0]?.({ payload: {} }, ctx)).toBeUndefined();
    pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
  }
});

it("preserves restored tier intent while metadata loads and applies it on a ready broadcast", async () => {
  const pi = createFakePi({ registry: [model], noTierPublisher: true });
  pi.api.events.on(SERVICE_TIERS_REQUEST, (raw) => pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame({ requestId: (raw as { requestId: string }).requestId, status: "loading", policies: [] })));
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx } = createFakeContext({ pi, model, branch: [{ type: "custom", customType: "superpi-controls", data: { version: 1, tier: "flex", longContext: false, timestamp: 1 } }] });
  await companion.restore(ctx);
  expect(companion.buildState(ctx).tiers).toEqual([]);
  pi.emitEvent(SERVICE_TIERS_SNAPSHOT, frame({ revision: 2 }));
  await flush();
  expect(companion.buildState(ctx).settings.tier).toBe("flex");
});

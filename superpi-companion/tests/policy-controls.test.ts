import { expect, it } from "vitest";
import { createCompanion } from "../src/companion.ts";
import { CONTEXT_POLICY_SNAPSHOT } from "../src/context-policy.ts";
import { encodeRequest, STATE_NOTIFY_PREFIX } from "../src/protocol.ts";
import { createFakePi, createFakeContext, readReply } from "./harness.ts";

const model = { provider: "plexus", id: "model", api: "openai-responses", contextWindow: 1_000_000 };
const policy = { provider: "plexus", modelId: "model", maxContextTokens: 1_000_000, shortContextBudgetTokens: 200_000 };
const configure = (longContext: boolean) => encodeRequest({ version: 1, sessionKey: "key", requestId: "cfg", operation: "configure", data: { longContext } });
const refresh = (pi: ReturnType<typeof createFakePi>, revision: number, policies: unknown[]) => pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, { version: 1, publisherId: "00000000-0000-4000-8000-000000000001", revision, status: "ready", policies });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

it("retains saved On intent while metadata loads, without applying an unknown budget", async () => {
  const pi = createFakePi({ registry: [model] });
  const requests = "plexus:context-policy:request:v1";
  pi.eventHandlers.get(requests)?.clear();
  pi.api.events.on(requests, (request) => pi.emitEvent(CONTEXT_POLICY_SNAPSHOT, { version: 1, publisherId: "00000000-0000-4000-8000-000000000001", revision: 1, requestId: (request as { requestId: string }).requestId, status: "loading", policies: [] }));
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx } = createFakeContext({ pi, model, branch: [{ type: "custom", customType: "superpi-controls", data: { version: 1, tier: "fast", longContext: true, timestamp: 1 } }] });
  await companion.restore(ctx);
  expect(companion.buildState(ctx).settings.longContext).toBe(false);
  expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
  refresh(pi, 2, [policy]);
  await flush();
  expect(companion.buildState(ctx).settings.longContext).toBe(true);
  expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
});

it("keeps the toggle available after an apply refusal so the user can retry", async () => {
  const pi = createFakePi({ registry: [model], policies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx, notifies } = createFakeContext({ pi, model });
  await companion.restore(ctx);
  await companion.handleArgs(configure(true), ctx);
  pi.setModelRefuses = true;
  await companion.handleArgs(configure(false), ctx);
  expect(readReply(notifies).ok).toBe(false);
  expect(companion.buildState(ctx)).toMatchObject({ longContextAvailable: true, settings: { longContext: true }, contextPolicyError: expect.any(String) });
  pi.setModelRefuses = false;
  await companion.handleArgs(configure(false), ctx);
  expect(pi.sessionModel?.contextWindow).toBe(200_000);
  expect(companion.buildState(ctx).contextPolicyError).toBeUndefined();
});

it("repairs silent registry replacement before starting model work", async () => {
  const pi = createFakePi({ registry: [model], policies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx } = createFakeContext({ pi, model });
  await companion.restore(ctx);
  expect(pi.sessionModel?.contextWindow).toBe(200_000);
  pi.sessionModel = model;
  await pi.handlers.get("before_agent_start")?.[0]?.({}, ctx);
  expect(pi.sessionModel?.contextWindow).toBe(200_000);
});

it("starts with the short budget, toggles to the maximum, and updates/removes live policies", async () => {
  const pi = createFakePi({ registry: [model], policies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx, notifies } = createFakeContext({ pi, model });
  await companion.restore(ctx);
  expect(pi.sessionModel?.contextWindow).toBe(200_000);
  expect(companion.buildState(ctx).longContextAvailable).toBe(true);
  expect(model.contextWindow).toBe(1_000_000);
  await companion.handleArgs(configure(true), ctx);
  expect(readReply(notifies).ok).toBe(true);
  expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
  refresh(pi, 2, [{ ...policy, maxContextTokens: 800_000, shortContextBudgetTokens: 100_000 }]);
  await flush();
  expect(pi.sessionModel?.contextWindow).toBe(800_000);
  expect(notifies.at(-1)?.message.startsWith(STATE_NOTIFY_PREFIX)).toBe(true);
  refresh(pi, 3, []);
  await flush();
  expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
  expect(companion.buildState(ctx).longContextAvailable).toBe(false);
  expect(companion.buildState(ctx).settings.longContext).toBe(false);
  await companion.handleArgs(configure(true), ctx);
  expect(readReply(notifies).ok).toBe(false);
});

it("keeps unqualified/equal-budget models unchanged and children independent", async () => {
  for (const origin of ["root", "child"] as const) {
    const pi = createFakePi({ registry: [model], policies: [{ ...policy, shortContextBudgetTokens: policy.maxContextTokens }] });
    const companion = createCompanion(pi.api, { origin, sessionKey: "key" });
    const { ctx } = createFakeContext({ pi, model });
    await companion.restore(ctx);
    refresh(pi, 2, [policy]);
    await flush();
    expect(pi.sessionModel?.contextWindow).toBe(origin === "root" ? 200_000 : 1_000_000);
    if (origin === "child") expect(companion.buildState(ctx).longContextAvailable).toBe(false);
    pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    expect(pi.eventHandlers.get(CONTEXT_POLICY_SNAPSHOT)?.size).toBe(0);
  }
});

it("resets selection on a model without policy and ignores old-model baselines", async () => {
  const next = { ...model, id: "other", contextWindow: 128_000 };
  const pi = createFakePi({ registry: [model, next], policies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx } = createFakeContext({ pi, model });
  await companion.restore(ctx);
  await companion.handleArgs(configure(true), ctx);
  pi.sessionModel = next;
  await pi.handlers.get("model_select")?.[0]?.({ model: next }, ctx);
  expect(pi.sessionModel?.contextWindow).toBe(128_000);
  expect(companion.buildState(ctx).settings.longContext).toBe(false);
  expect(companion.buildState(ctx).longContextAvailable).toBe(false);
});

it("applies the short budget when Pi selects a catalog snapshot copy", async () => {
  const other = { ...model, id: "other", contextWindow: 128_000 };
  const pi = createFakePi({ registry: [model, other], policies: [policy] });
  const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
  const { ctx } = createFakeContext({ pi, model: other });
  await companion.restore(ctx);
  const selected = { ...model };
  pi.sessionModel = selected;
  await pi.handlers.get("model_select")?.[0]?.({ model: selected }, ctx);
  expect(pi.sessionModel?.contextWindow).toBe(200_000);
  expect(model.contextWindow).toBe(1_000_000);
});

it("restores persisted long-context selection only when a current policy supports it", async () => {
  for (const policies of [[policy], []]) {
    const pi = createFakePi({ registry: [model], policies });
    const companion = createCompanion(pi.api, { origin: "root", sessionKey: "key" });
    const { ctx } = createFakeContext({ pi, model, branch: [{ type: "custom", customType: "superpi-controls", data: { version: 1, tier: "fast", longContext: true, contextWindow: 1_050_000, timestamp: 1 } }] });
    await companion.restore(ctx);
    expect(companion.buildState(ctx).settings.longContext).toBe(policies.length > 0);
    expect(companion.buildState(ctx).longContextTarget).toBe(policies.length ? 1_000_000 : undefined);
  }
});

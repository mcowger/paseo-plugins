import { describe, expect, it } from "vitest";
import { planContextBudget, type ContextTracking } from "../src/context.ts";

interface CatalogModel {
  id: string;
  provider: string;
  contextWindow: number;
}

function catalog(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return { id: "gpt-5.6", provider: "plexus", contextWindow: 200_000, ...overrides };
}

function emptyTracking(): ContextTracking {
  return { model: undefined, baseline: undefined };
}

const policy = { provider: "plexus", modelId: "gpt-5.6", maxContextTokens: 1_000_000, shortContextBudgetTokens: 180_000 };

describe("planContextBudget", () => {
  it("returns a session-local clone and leaves the catalog object untouched", () => {
    const source = catalog();
    const plan = planContextBudget(emptyTracking(), source, policy, true);
    expect(plan?.model).not.toBe(source);
    expect(plan?.model).toMatchObject({ id: "gpt-5.6", provider: "plexus", contextWindow: 1_000_000 });
    expect(plan?.baseline).toBe(200_000);
    expect(source.contextWindow).toBe(200_000);
  });

  it("keeps the recorded baseline across repeated toggles", () => {
    const source = catalog();
    const tracking = emptyTracking();
    const first = planContextBudget(tracking, source, policy, true)!;
    tracking.model = source;
    tracking.baseline = first.baseline;

    // Re-planning the same catalog source reuses the recorded baseline instead
    // of accumulating the expanded window.
    const second = planContextBudget(tracking, first.model, policy, false)!;
    expect(second.baseline).toBe(200_000);
    expect(second.model.contextWindow).toBe(180_000);
    expect(source.contextWindow).toBe(200_000);
  });

  it("records a fresh baseline when the catalog source changes", () => {
    const tracking = emptyTracking();
    const first = catalog();
    tracking.model = first;
    tracking.baseline = first.contextWindow;

    const next = catalog({ id: "claude", provider: "plexus", contextWindow: 300_000 });
    const second = planContextBudget(tracking, next, undefined, true)!;
    expect(second.baseline).toBe(300_000);
    expect(second.model.contextWindow).toBe(300_000);
    expect(second.available).toBe(false);
    expect(next.contextWindow).toBe(300_000);
  });

  it("refuses a model without a finite context window", () => {
    expect(planContextBudget(emptyTracking(), undefined, policy, true)).toBeUndefined();
    expect(planContextBudget(emptyTracking(), catalog({ contextWindow: Number.NaN }), policy, true)).toBeUndefined();
  });
});

describe("missing policy", () => {
  it("clones the current session model back to the tracked baseline", () => {
    const source = catalog();
    const tracking = emptyTracking();
    const expanded = planContextBudget(tracking, source, policy, true)!;
    tracking.model = source;
    tracking.baseline = expanded.baseline;

    const restored = planContextBudget(tracking, expanded.model, undefined, false);
    expect(restored?.model).not.toBe(expanded.model);
    expect(restored?.model.contextWindow).toBe(200_000);
    expect(tracking.baseline).toBe(200_000);
    expect(source.contextWindow).toBe(200_000);
  });

  it("leaves a model without a distinct budget unchanged", () => {
    const tracking = emptyTracking();
    const plan = planContextBudget(tracking, catalog(), { ...policy, shortContextBudgetTokens: 1_000_000 }, true);
    expect(plan?.available).toBe(false);
    expect(plan?.model.contextWindow).toBe(200_000);
  });
});

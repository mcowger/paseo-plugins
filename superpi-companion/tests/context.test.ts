import { describe, expect, it } from "vitest";
import {
  clearExpandedContext,
  planExpandedContext,
  planRestoredContext,
  trackExpandedContext,
  type ExpandedContextTracking,
} from "../src/context.ts";

interface CatalogModel {
  id: string;
  provider: string;
  contextWindow: number;
}

function catalog(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return { id: "gpt-5.6", provider: "plexus", contextWindow: 200_000, ...overrides };
}

function emptyTracking(): ExpandedContextTracking {
  return { model: undefined, baseline: undefined };
}

describe("planExpandedContext", () => {
  it("returns a session-local clone and leaves the catalog object untouched", () => {
    const source = catalog();
    const plan = planExpandedContext(emptyTracking(), source);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.source).toBe(source);
    expect(plan.model).not.toBe(source);
    expect(plan.model).toMatchObject({ id: "gpt-5.6", provider: "plexus", contextWindow: 1_050_000 });
    expect(plan.baseline).toBe(200_000);
    expect(plan.contextWindow).toBe(1_050_000);
    expect(source.contextWindow).toBe(200_000);
  });

  it("keeps the recorded baseline across repeated toggles", () => {
    const source = catalog();
    const tracking = emptyTracking();
    const first = planExpandedContext(tracking, source);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    trackExpandedContext(tracking, first.source, first.baseline);

    // Re-planning the same catalog source reuses the recorded baseline instead
    // of accumulating the expanded window.
    const second = planExpandedContext(tracking, source);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.baseline).toBe(200_000);
    expect(second.contextWindow).toBe(1_050_000);
    expect(source.contextWindow).toBe(200_000);
  });

  it("records a fresh baseline when the catalog source changes", () => {
    const tracking = emptyTracking();
    const first = planExpandedContext(tracking, catalog());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    trackExpandedContext(tracking, first.source, first.baseline);

    const next = catalog({ id: "claude", provider: "plexus", contextWindow: 300_000 });
    const second = planExpandedContext(tracking, next);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.baseline).toBe(300_000);
    expect(second.contextWindow).toBe(1_050_000);
    expect(next.contextWindow).toBe(300_000);
  });

  it("refuses a model without a finite context window", () => {
    expect(planExpandedContext(emptyTracking(), undefined).ok).toBe(false);
    expect(
      planExpandedContext(emptyTracking(), { contextWindow: Number.NaN }).ok,
    ).toBe(false);
  });
});

describe("planRestoredContext", () => {
  it("clones the current session model back to the tracked baseline", () => {
    const source = catalog();
    const tracking = emptyTracking();
    const expanded = planExpandedContext(tracking, source);
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    trackExpandedContext(tracking, expanded.source, expanded.baseline);

    const restored = planRestoredContext(tracking, expanded.model);
    expect(restored).not.toBe(expanded.model);
    expect(restored?.contextWindow).toBe(200_000);
    expect(tracking.baseline).toBe(200_000);
    expect(source.contextWindow).toBe(200_000);
  });

  it("returns undefined when nothing is tracked", () => {
    const tracking = emptyTracking();
    expect(planRestoredContext(tracking, catalog())).toBeUndefined();
    clearExpandedContext(tracking);
    expect(tracking.model).toBeUndefined();
    expect(tracking.baseline).toBeUndefined();
  });
});

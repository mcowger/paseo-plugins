import { expect, it } from "vitest";
import { companionStateSchema, contextSettingPresentation } from "./companion.js";

it("preserves companion context limits and exposes both state and actual budget", () => {
  const state = companionStateSchema.parse({ capabilities: [], settings: { tier: "default", longContext: true }, contextWindow: 1_000_000, shortContextBudgetTokens: 200_000, longContextAvailable: true, longContextTarget: 1_000_000 });
  const presentation = contextSettingPresentation(state, 1_000_000);
  expect(presentation.label).toBe("1M");
  expect(presentation.description).toContain("Short budget: 200,000 tokens");
  expect(presentation.description).toContain("Maximum: 1,000,000 tokens");
  expect(presentation.description).toContain("Limits supplied by Plexus");
});

it("does not invent a target for older companions or confuse a toggle with successful expansion", () => {
  expect(contextSettingPresentation(undefined, 128_000).label).toBe("128K");
  const state = companionStateSchema.parse({ capabilities: [], settings: { tier: "default", longContext: true }, contextWindow: 128_000 });
  expect(contextSettingPresentation(state).label).toBe("128K");
  expect(contextSettingPresentation(state).description).toContain("Maximum: unknown");
});

it("prefers the observed Pi budget to a stale companion model window", () => {
  const state = companionStateSchema.parse({ capabilities: [], settings: { tier: "default", longContext: false }, contextWindow: 200_000 });
  expect(contextSettingPresentation(state, 128_000).label).toBe("128K");
});

it("rounds context labels to whole K or M without extra text", () => {
  for (const [budget, label] of [[272_000, "272K"], [1_050_000, "1M"], [1_048_576, "1M"], [128_512, "129K"], [999_999, "1M"], [512, "512"]] as const) {
    expect(contextSettingPresentation(undefined, budget).label).toBe(label);
  }
  expect(contextSettingPresentation(undefined).label).toBe("Unknown");
});

import { expect, it } from "vitest";
import { companionStateSchema, contextSettingPresentation } from "./companion.js";

it("preserves companion context limits and exposes both state and actual budget", () => {
  const state = companionStateSchema.parse({ capabilities: [], settings: { tier: "default", longContext: true }, contextWindow: 1_050_000, modelBaselineContextWindow: 200_000, longContextTarget: 1_050_000 });
  const presentation = contextSettingPresentation(state, 1_050_000);
  expect(presentation.label).toBe("Long context: On (1,050,000 tokens)");
  expect(presentation.description).toContain("Model baseline: 200,000 tokens");
  expect(presentation.description).toContain("Expansion target: 1,050,000 tokens");
  expect(presentation.description).toContain("not discovered backend capacity");
});

it("does not invent a target for older companions or confuse a toggle with successful expansion", () => {
  expect(contextSettingPresentation(undefined, 128_000).label).toBe("Long context: Off (128,000 tokens)");
  const state = companionStateSchema.parse({ capabilities: [], settings: { tier: "default", longContext: true }, contextWindow: 128_000 });
  expect(contextSettingPresentation(state).label).toBe("Long context: On (128,000 tokens)");
  expect(contextSettingPresentation(state).description).toContain("Expansion target: unknown");
});

it("prefers the observed Pi budget to a stale companion model window", () => {
  const state = companionStateSchema.parse({ capabilities: [], settings: { tier: "default", longContext: false }, contextWindow: 200_000 });
  expect(contextSettingPresentation(state, 128_000).label).toBe("Long context: Off (128,000 tokens)");
});

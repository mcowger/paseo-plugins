import { describe, expect, it } from "vitest";

import { presetsToModes, readActivePresetName } from "./presets.js";

const PLAN_PRESET = {
  id: "plan",
  name: "Plan",
  model: "openai/gpt-5.2",
  thinkingLevel: "high" as const,
};

describe("presetsToModes", () => {
  it("maps presets to provider modes", () => {
    const modes = presetsToModes({
      plan: PLAN_PRESET,
      implement: {
        id: "implement",
        name: "Implement",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "medium",
        tools: ["read", "mcp_*"],
        appendSystemPrompt: "Make focused changes.",
      },
    });
    expect(modes).toEqual([
      {
        id: "plan",
        label: "Plan",
        icon: "Bot",
        description: "openai/gpt-5.2 · thinking: high",
      },
      {
        id: "implement",
        label: "Implement",
        icon: "Bot",
        description:
          "anthropic/claude-sonnet-4-5 · thinking: medium · tools: read, mcp_* · prompt: Make focused changes.",
      },
    ]);
  });

  it("marks a mode as modified when the effective session diverges", () => {
    expect(presetsToModes({ plan: PLAN_PRESET }, "plan", true)[0]?.label).toBe("Plan (modified)");
  });
});

describe("readActivePresetName", () => {
  it("returns the latest preset-state entry name", () => {
    const entries = [
      { type: "message" },
      { type: "custom", customType: "preset-state", data: { name: "plan" } },
      { type: "custom", customType: "other", data: { name: "nope" } },
      { type: "custom", customType: "preset-state", data: { name: "implement" } },
    ];
    expect(readActivePresetName(entries)).toBe("implement");
  });

  it("returns null when no preset-state entries exist", () => {
    expect(readActivePresetName([{ type: "message" }])).toBeNull();
    expect(readActivePresetName(null)).toBeNull();
    expect(
      readActivePresetName([{ type: "custom", customType: "preset-state", data: {} }]),
    ).toBeNull();
  });
});

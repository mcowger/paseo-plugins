import { describe, expect, test } from "vitest";

import type { PiModel } from "./rpc-types.js";
import { thinkingConfigForModel } from "./thinking.js";

const restricted: PiModel = {
  provider: "kimi-coding",
  id: "kimi-k3",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
};

describe("Pi thinking capabilities", () => {
  test("advertises only mapped levels and clamps the default upward", () => {
    expect(thinkingConfigForModel(restricted)).toEqual({
      thinkingOptions: [
        { id: "low", label: "Low", description: "Faster reasoning" },
        { id: "high", label: "High", description: "Deeper reasoning", isDefault: true },
        { id: "max", label: "Max", description: "Extreme reasoning" },
      ],
      defaultThinkingOptionId: "high",
    });
  });

  test("does not infer extended thinking levels without explicit mappings", () => {
    const config = thinkingConfigForModel({
      provider: "openai",
      id: "model",
      reasoning: true,
    });

    expect(config.thinkingOptions.map((option) => option.id)).toEqual([
      "off", "minimal", "low", "medium", "high",
    ]);
    expect(config.defaultThinkingOptionId).toBe("medium");
  });

  test("does not expose thinking configuration for non-reasoning models", () => {
    expect(thinkingConfigForModel({ provider: "openai", id: "model", reasoning: false })).toEqual({
      thinkingOptions: [],
      defaultThinkingOptionId: undefined,
    });
  });
});

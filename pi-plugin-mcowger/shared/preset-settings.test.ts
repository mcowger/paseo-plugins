import { describe, expect, it } from "vitest";

import { piPresetsSettings } from "./preset-settings.js";

describe("piPresetsSettings", () => {
  it("defaults to an empty preset document", () => {
    expect(piPresetsSettings.schema.parse({})).toEqual({ presets: [] });
  });

  it("rejects duplicate preset ids", () => {
    const result = piPresetsSettings.schema.safeParse({
      presets: [
        { id: "plan", name: "Plan", model: "openai/gpt-5.2", thinkingLevel: "high" },
        { id: "plan", name: "Again", model: "openai/gpt-5.2", thinkingLevel: "high" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts glob tool patterns and optional prompt text", () => {
    expect(
      piPresetsSettings.schema.parse({
        presets: [
          {
            id: "implement",
            name: "Implement",
            model: "anthropic/claude-sonnet-4-5",
            thinkingLevel: "high",
            tools: ["read", "mcp_*"],
            appendSystemPrompt: "Make focused changes.",
          },
        ],
      }),
    ).toMatchObject({ presets: [{ tools: ["read", "mcp_*"] }] });
  });
});

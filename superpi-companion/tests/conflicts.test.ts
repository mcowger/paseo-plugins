import { describe, expect, it } from "vitest";
import { detectControlConflicts, KNOWN_CONTROL_OWNERS } from "../src/conflicts.ts";
import { applyTierToPayload, isTierApplicable } from "../src/tier.ts";

describe("detectControlConflicts", () => {
  it("matches declared known owner commands", () => {
    const conflicts = detectControlConflicts([
      { name: "service-tier", source: "extension" },
      { name: "fast", source: "extension" },
      { name: "flex", source: "extension" },
      { name: "long-context", source: "extension" },
    ]);
    expect(conflicts.map((conflict) => conflict.owner)).toEqual(["plexus-pi", "pi-microgpt"]);
    for (const conflict of conflicts) expect(conflict.resolution.length).toBeGreaterThan(0);
  });

  it("ignores unrelated extension commands and non-extension sources", () => {
    expect(
      detectControlConflicts([
        { name: "plexus-models", source: "extension" },
        { name: "service-tier", source: "prompt" },
        { name: "fast", source: "skill" },
      ]),
    ).toEqual([]);
  });

  it("keeps the known owner table resolvable", () => {
    expect(KNOWN_CONTROL_OWNERS.length).toBeGreaterThan(0);
  });
});

describe("tier mapping", () => {
  it("maps fast to the OpenAI priority service tier", () => {
    expect(applyTierToPayload({ model: "gpt" }, { api: "openai-responses", id: "gpt" }, "fast")).toEqual({
      model: "gpt",
      service_tier: "priority",
    });
  });

  it("maps flex and ultrafast to literal service tiers", () => {
    expect(applyTierToPayload({}, { api: "openai-codex-responses" }, "flex")).toEqual({ service_tier: "flex" });
    expect(applyTierToPayload({}, { api: "openai-responses" }, "ultrafast")).toEqual({
      service_tier: "ultrafast",
    });
  });

  it("uses Anthropic fast mode for fast only", () => {
    expect(applyTierToPayload({ betas: ["existing"] }, { api: "anthropic-messages" }, "fast")).toEqual({
      betas: ["existing", "fast-mode-2026-02-01"],
      speed: "fast",
    });
    expect(applyTierToPayload({}, { api: "anthropic-messages" }, "flex")).toBeUndefined();
  });

  it("leaves default and unknown dialects untouched", () => {
    expect(isTierApplicable({ api: "openai-responses" }, "default")).toBe(true);
    expect(applyTierToPayload({}, { api: "openai-responses" }, "default")).toBeUndefined();
    expect(applyTierToPayload({}, { api: "mystery-api" }, "fast")).toBeUndefined();
    expect(isTierApplicable({ api: "mystery-api" }, "fast")).toBe(false);
  });
});

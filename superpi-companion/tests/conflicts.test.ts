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
  const policy = { provider: "plexus", modelId: "gpt", serviceTiers: ["auto", "standard", "flex", "priority", "ultrafast"] };
  it("injects exact advertised canonical tiers for all Plexus request dialects", () => {
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
      for (const tier of policy.serviceTiers) expect(applyTierToPayload({ model: "gpt" }, { provider: "plexus", api, id: "gpt" }, tier, policy)).toEqual({ model: "gpt", service_tier: tier });
    }
  });
  it("does not inject guesses, legacy names, foreign policies or native-provider requests", () => {
    const model = { provider: "plexus", id: "gpt" };
    expect(applyTierToPayload({}, model, "fast", policy)).toBeUndefined();
    expect(applyTierToPayload({}, model, "default", undefined)).toBeUndefined();
    expect(applyTierToPayload({}, model, "priority", { ...policy, modelId: "other" })).toBeUndefined();
    expect(applyTierToPayload({}, { provider: "anthropic", id: "gpt" }, "priority", policy)).toBeUndefined();
    expect(isTierApplicable(model, "flex", policy)).toBe(true);
    expect(isTierApplicable(model, "fast", policy)).toBe(false);
  });
  it("leaves malformed payloads untouched", () => {
    for (const payload of [null, [], "text"]) expect(applyTierToPayload(payload, { provider: "plexus", id: "gpt" }, "priority", policy)).toBeUndefined();
  });
});

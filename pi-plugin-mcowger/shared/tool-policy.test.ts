import { describe, expect, it } from "vitest";

import { piToolPolicySettings } from "./tool-policy.js";

describe("piToolPolicySettings", () => {
  it("provides the restrictive-policy defaults", () => {
    expect(piToolPolicySettings.schema.parse({})).toEqual({
      piTools: { mode: "inherit", allowedPatterns: [], blockedPatterns: [] },
      paseoTools: { enabled: true, disabledTools: [] },
    });
  });

  it("trims and deduplicates patterns and canonical tool ids", () => {
    expect(piToolPolicySettings.schema.parse({
      piTools: { mode: "allowlist", allowedPatterns: [" read ", "read", "  "], blockedPatterns: [" bash ", "bash"] },
      paseoTools: { disabledTools: [" create_workspace ", "create_workspace"] },
    })).toEqual({
      piTools: { mode: "allowlist", allowedPatterns: ["read"], blockedPatterns: ["bash"] },
      paseoTools: { enabled: true, disabledTools: ["create_workspace"] },
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  createPiToolPolicyStore,
  filterPaseoToolNames,
  formatPiToolPolicyDiagnostic,
  piToolPolicyRequiresKnownBaseline,
  resolvePiToolPolicy,
} from "./tool-policy.js";

describe("resolvePiToolPolicy", () => {
  const known = ["read", "bash", "edit", "mcp_linear_search", "inactive"];

  it("keeps baseline order and never enables inactive known tools", () => {
    expect(resolvePiToolPolicy(["read", "bash", "missing"], known, {
      mode: "allowlist", allowedPatterns: ["read", "inactive"], blockedPatterns: [],
    })).toEqual(["read"]);
  });

  it("applies block patterns after allow patterns", () => {
    expect(resolvePiToolPolicy(["read", "bash", "mcp_linear_search"], known, {
      mode: "allowlist", allowedPatterns: ["*"], blockedPatterns: ["bash", "mcp_linear_*"]
    })).toEqual(["read"]);
  });

  it("leaves the SDK selection untouched when the active list is unavailable", () => {
    expect(resolvePiToolPolicy(undefined, known, {
      mode: "inherit", allowedPatterns: [], blockedPatterns: ["bash"],
    })).toBeUndefined();
  });

  it("requires a known baseline for restrictive policies", () => {
    expect(piToolPolicyRequiresKnownBaseline({ mode: "inherit", allowedPatterns: [], blockedPatterns: [] })).toBe(false);
    expect(piToolPolicyRequiresKnownBaseline({ mode: "inherit", allowedPatterns: [], blockedPatterns: ["bash"] })).toBe(true);
    expect(piToolPolicyRequiresKnownBaseline({ mode: "allowlist", allowedPatterns: [], blockedPatterns: [] })).toBe(true);
  });
});

describe("filterPaseoToolNames", () => {
  it("filters exact canonical names before bridge sanitization", () => {
    expect(filterPaseoToolNames(["create_workspace", "create_workspace_extra"], {
      enabled: true, disabledTools: ["create_workspace"],
    })).toEqual(["create_workspace_extra"]);
  });

  it("disables the complete catalog", () => {
    expect(filterPaseoToolNames(["create_agent", "create_workspace"], {
      enabled: false, disabledTools: [],
    })).toEqual([]);
  });
});

describe("formatPiToolPolicyDiagnostic", () => {
  it("reports Pi and host categories without listing tool names", () => {
    expect(formatPiToolPolicyDiagnostic(
      ["read", "bash", "mcp_paseo_create_workspace"],
      ["read"],
      ["mcp_paseo_create_workspace"],
      [],
    )).toBe("Pi tool policy: active tools 3 -> 1; blocked 1 Pi tools and 1 Paseo host tools.");
  });
});

describe("createPiToolPolicyStore", () => {
  it("accepts a real initial revision named missing", () => {
    const store = createPiToolPolicyStore();
    const settings = store.snapshot().settings;
    store.update(settings, "missing", null);
    expect(store.snapshot().revision).toBe("missing");
  });

  it("rejects stale revisions and accepts idempotent writes", () => {
    const store = createPiToolPolicyStore();
    const settings = store.snapshot().settings;
    store.update(settings, "revision-1", null);
    store.update(settings, "revision-1", "revision-0");
    expect(() => store.update(settings, "revision-2", null)).toThrow(/changed/);
    expect(() => store.update(settings, "revision-2", "revision-0")).toThrow(/changed/);
  });
});

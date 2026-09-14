import { describe, expect, it } from "vitest";

import {
  createPiToolPolicyStore,
  filterPaseoToolNames,
  filterPaseoToolNamesForProfile,
  formatPiToolPolicyDiagnostic,
  piToolPolicyRequiresKnownBaseline,
  resolveConfiguredToolPolicy,
  resolveExternalMcpToolNames,
  resolvePiToolPolicy,
  resolveStrictActiveToolNames,
  type BridgedMcpTool,
  type ProfileToolPolicy,
} from "./tool-policy.js";

const fallbackPolicy = { mode: "inherit" as const, allowedPatterns: [], blockedPatterns: [] };
const explorePolicy: ProfileToolPolicy = {
  profileId: "profile-explore",
  allowedPiToolNames: ["read"],
  allowedPaseoToolNames: ["create_agent"],
  allowedExternalMcpPatterns: ["mcp_linear_*"],
};
const bridgeTools: BridgedMcpTool[] = [
  { piName: "mcp_host_create_agent", canonicalName: "create_agent", isPaseoTool: true },
  { piName: "mcp_host_create_workspace", canonicalName: "create_workspace", isPaseoTool: true },
  { piName: "mcp_linear_search", canonicalName: "search", isPaseoTool: false },
  { piName: "mcp_linear_write", canonicalName: "write", isPaseoTool: false },
];

describe("resolveConfiguredToolPolicy", () => {
  it("uses a configured profile only for an exact marker match", () => {
    expect(resolveConfiguredToolPolicy("profile-explore", fallbackPolicy, [explorePolicy])).toEqual({
      source: "profile",
      policy: explorePolicy,
    });
    for (const marker of [undefined, null, " profile-explore", "profile-explore ", "unknown"]) {
      expect(resolveConfiguredToolPolicy(marker, fallbackPolicy, [explorePolicy])).toEqual({
        source: "fallback",
        policy: fallbackPolicy,
      });
    }
  });

  it("uses one matching launch signature only when the marker is absent", () => {
    const launchSignature = {
      model: "plexus/gpt-5.6-terra",
      mode: "",
      thinkingOption: "medium",
    };
    const policy = { ...explorePolicy, launchSignature };
    const launchConfig = {
      model: "plexus/gpt-5.6-terra",
      mode: "",
      thinkingOption: "medium",
    };

    expect(resolveConfiguredToolPolicy(undefined, fallbackPolicy, [policy], launchConfig)).toEqual({
      source: "profile",
      policy,
    });
    expect(resolveConfiguredToolPolicy("unknown", fallbackPolicy, [policy], launchConfig)).toEqual({
      source: "fallback",
      policy: fallbackPolicy,
    });
    expect(resolveConfiguredToolPolicy(undefined, fallbackPolicy, [policy, {
      ...policy,
      profileId: "profile-same-launch-config",
    }], launchConfig)).toEqual({
      source: "fallback",
      policy: fallbackPolicy,
    });
  });

  it("preserves a deliberately empty configured policy", () => {
    const emptyPolicy: ProfileToolPolicy = {
      profileId: "profile-chat-only",
      allowedPiToolNames: [],
      allowedPaseoToolNames: [],
      allowedExternalMcpPatterns: [],
    };
    expect(resolveConfiguredToolPolicy("profile-chat-only", fallbackPolicy, [emptyPolicy])).toEqual({
      source: "profile",
      policy: emptyPolicy,
    });
  });
});

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

describe("resolveStrictActiveToolNames", () => {
  it("preserves baseline order and never enables known but inactive tools", () => {
    expect(resolveStrictActiveToolNames(
      ["bash", "read", "mcp_host_create_agent", "mcp_linear_search"],
      ["read", "bash", "edit", "mcp_host_create_agent", "mcp_linear_search", "mcp_linear_write"],
      explorePolicy,
      bridgeTools,
    )).toEqual(["read", "mcp_host_create_agent", "mcp_linear_search"]);
  });

  it("supports a canonical Paseo selection even with a non-paseo server alias", () => {
    expect(resolveStrictActiveToolNames(
      ["mcp_host_create_agent", "mcp_host_create_workspace"],
      undefined,
      explorePolicy,
      bridgeTools,
    )).toEqual(["mcp_host_create_agent"]);
  });

  it("keeps an intentional empty profile policy chat-only", () => {
    expect(resolveStrictActiveToolNames(
      ["read", "mcp_host_create_agent", "mcp_linear_search"],
      undefined,
      { ...explorePolicy, allowedPiToolNames: [], allowedPaseoToolNames: [], allowedExternalMcpPatterns: [] },
      bridgeTools,
    )).toEqual([]);
  });

  it("does not resolve a strict catalog without the active baseline", () => {
    expect(resolveStrictActiveToolNames(undefined, ["read"], explorePolicy, bridgeTools)).toBeUndefined();
  });
});

describe("resolveExternalMcpToolNames", () => {
  it("matches only external bridge tools and cannot admit Paseo-origin tools", () => {
    expect(resolveExternalMcpToolNames(bridgeTools, ["mcp_*"])).toEqual([
      "mcp_linear_search",
      "mcp_linear_write",
    ]);
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

  it("uses exact canonical allow decisions for profile policies", () => {
    expect(filterPaseoToolNamesForProfile(
      ["create_agent", "create_agent_extra"],
      ["create_agent"],
    )).toEqual(["create_agent"]);
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

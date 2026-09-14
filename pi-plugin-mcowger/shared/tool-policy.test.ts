import { describe, expect, it } from "vitest";

import {
  getPiActiveProfileRpc,
  getPiToolPolicyKnownToolsRpc,
  getPiToolPolicyProfilesRpc,
  piToolPolicySettings,
  syncPiToolPolicyProfileMarkersRpc,
} from "./tool-policy.js";

describe("piToolPolicySettings", () => {
  it("provides version-2 fallback defaults", () => {
    expect(piToolPolicySettings.version).toBe(2);
    expect(piToolPolicySettings.schema.parse({})).toEqual({
      piTools: { mode: "inherit", allowedPatterns: [], blockedPatterns: [] },
      paseoTools: { enabled: true, disabledTools: [] },
      profilePolicies: [],
    });
  });

  it("migrates version-1 values while preserving the fallback policy", () => {
    expect(piToolPolicySettings.migrate?.({
      piTools: { mode: "allowlist", allowedPatterns: ["read"], blockedPatterns: ["bash"] },
      paseoTools: { enabled: false, disabledTools: ["create_agent"] },
    }, 1)).toEqual({
      piTools: { mode: "allowlist", allowedPatterns: ["read"], blockedPatterns: ["bash"] },
      paseoTools: { enabled: false, disabledTools: ["create_agent"] },
      profilePolicies: [],
    });
  });

  it("trims and deduplicates fallback and profile policy selections", () => {
    expect(piToolPolicySettings.schema.parse({
      piTools: { mode: "allowlist", allowedPatterns: [" read ", "read", "  "], blockedPatterns: [" bash ", "bash"] },
      paseoTools: { disabledTools: [" create_workspace ", "create_workspace"] },
      profilePolicies: [{
        profileId: " explore ",
        allowedPiToolNames: [" read ", "read", ""],
        allowedPaseoToolNames: [" create_agent ", "create_agent"],
        allowedExternalMcpPatterns: [" mcp_linear_* ", "mcp_linear_*", ""],
      }],
    })).toEqual({
      piTools: { mode: "allowlist", allowedPatterns: ["read"], blockedPatterns: ["bash"] },
      paseoTools: { enabled: true, disabledTools: ["create_workspace"] },
      profilePolicies: [{
        profileId: "explore",
        allowedPiToolNames: ["read"],
        allowedPaseoToolNames: ["create_agent"],
        allowedExternalMcpPatterns: ["mcp_linear_*"],
      }],
    });
  });

  it("preserves case-sensitive external MCP patterns", () => {
    expect(piToolPolicySettings.schema.parse({
      profilePolicies: [{
        profileId: "explore",
        allowedExternalMcpPatterns: ["MCP_Linear_*", "mcp_linear_*"],
      }],
    }).profilePolicies[0]?.allowedExternalMcpPatterns).toEqual(["MCP_Linear_*", "mcp_linear_*"]);
  });

  it("rejects duplicate profile policies after ID normalization", () => {
    expect(() => piToolPolicySettings.schema.parse({
      profilePolicies: [
        { profileId: " explore " },
        { profileId: "explore" },
      ],
    })).toThrow(/Duplicate profile policy: explore/);
  });

  it("accepts an intentional empty profile policy", () => {
    expect(piToolPolicySettings.schema.parse({
      profilePolicies: [{ profileId: "chat-only" }],
    }).profilePolicies).toEqual([{
      profileId: "chat-only",
      allowedPiToolNames: [],
      allowedPaseoToolNames: [],
      allowedExternalMcpPatterns: [],
    }]);
  });

  it("normalizes an optional profile launch signature", () => {
    expect(piToolPolicySettings.schema.parse({
      profilePolicies: [{
        profileId: "default",
        launchSignature: {
          model: " plexus/gpt-5.6-terra ",
          mode: " ",
          thinkingOption: " medium ",
        },
      }],
    }).profilePolicies[0]?.launchSignature).toEqual({
      model: "plexus/gpt-5.6-terra",
      mode: "",
      thinkingOption: "medium",
    });
  });
});

describe("profile tool-policy RPC contracts", () => {
  it("returns only the sanitized profile presentation model", () => {
    expect(getPiToolPolicyProfilesRpc.output.parse({
      profiles: [{ id: "profile-1", name: "Explore", notes: "Read-only work" }],
    })).toEqual({
      profiles: [{ id: "profile-1", name: "Explore", notes: "Read-only work" }],
    });
    expect(() => getPiToolPolicyProfilesRpc.output.parse({
      profiles: [{ id: "profile-1", name: "Explore", credentials: { token: "secret" } }],
    })).toThrow();
  });

  it("validates the exact active profile identity response", () => {
    expect(getPiActiveProfileRpc.input.parse({ agentId: "agent-1" })).toEqual({ agentId: "agent-1" });
    expect(getPiActiveProfileRpc.output.parse({ profileId: "profile-1" })).toEqual({ profileId: "profile-1" });
    expect(getPiActiveProfileRpc.output.parse({ profileId: null })).toEqual({ profileId: null });
  });

  it("keeps marker sync narrow and returns sanitized profiles", () => {
    expect(syncPiToolPolicyProfileMarkersRpc.input.parse({})).toEqual({});
    expect(syncPiToolPolicyProfileMarkersRpc.output.parse({
      profiles: [{ id: "profile-1", name: "Explore", model: "pi/model" }],
    })).toEqual({
      profiles: [{ id: "profile-1", name: "Explore", model: "pi/model" }],
    });
  });

  it("limits known-tool discovery to presentation-safe fields", () => {
    expect(getPiToolPolicyKnownToolsRpc.output.parse({
      tools: [{
        name: "read",
        description: "Read files",
        source: { kind: "builtin", label: "Pi" },
        baselineActive: true,
      }],
    })).toEqual({
      tools: [{
        name: "read",
        description: "Read files",
        source: { kind: "builtin", label: "Pi" },
        baselineActive: true,
      }],
    });
    expect(() => getPiToolPolicyKnownToolsRpc.output.parse({
      tools: [{ name: "read", baselineActive: true, inputSchema: { apiKey: "secret" } }],
    })).toThrow();
  });
});

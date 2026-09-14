import { describe, expect, it } from "vitest";

import type { PaseoApi } from "@getpaseo/client";

import { createPiProfileToolPolicyHandlers } from "./profile-tool-policy.js";
import { PI_TOOL_POLICY_PROFILE_ID_SETTING } from "../shared/tool-policy.js";

function fakePaseo(agentProfiles: unknown[]) {
  let profiles = agentProfiles;
  const patches: unknown[][] = [];
  const paseo = {
    config: {
      get: async () => ({ requestId: "get", config: { agentProfiles: profiles } }),
      patch: async ({ agentProfiles: next }: { agentProfiles: unknown[] }) => {
        patches.push(next);
        profiles = next;
        return { requestId: "patch", config: { agentProfiles: profiles } };
      },
    },
  } as unknown as PaseoApi;
  return { paseo, patches, profiles: () => profiles };
}

describe("Pi profile tool-policy RPC adapter", () => {
  it("returns only sanitized Pi profile summaries", async () => {
    const { paseo } = fakePaseo([
      {
        id: "pi-build",
        name: " Build ",
        provider: "pi-plugin-mcowger",
        model: "model-a",
        featureValues: { secret: "hidden" },
        credentials: "hidden",
      },
      { id: "other", name: "Other", provider: "other" },
    ]);

    await expect(createPiProfileToolPolicyHandlers().listProfiles(paseo)).resolves.toEqual({
      profiles: [{ id: "pi-build", name: "Build", model: "model-a" }],
    });
  });

  it("syncs markers through config patch while preserving unrelated profiles and fields", async () => {
    const { paseo, patches, profiles } = fakePaseo([
      {
        id: "pi-build",
        name: "Build",
        provider: "pi-plugin-mcowger",
        featureValues: { custom: true },
        unknown: "preserve",
      },
      { id: "other", name: "Other", provider: "other", keep: true },
    ]);

    await expect(createPiProfileToolPolicyHandlers().syncProfileMarkers(paseo)).resolves.toEqual({
      profiles: [{ id: "pi-build", name: "Build" }],
    });
    expect(patches).toHaveLength(1);
    expect(profiles()).toEqual([
      {
        id: "pi-build",
        name: "Build",
        provider: "pi-plugin-mcowger",
        featureValues: {
          custom: true,
          [PI_TOOL_POLICY_PROFILE_ID_SETTING]: "pi-build",
        },
        unknown: "preserve",
      },
      { id: "other", name: "Other", provider: "other", keep: true },
    ]);
  });
});

import { describe, expect, it } from "vitest";

import {
  createProfileToolPolicy,
  reconcileProfilePolicies,
  saveProfilePolicyWithRetry,
} from "./profile-policy-sync.js";

describe("profile launch signatures", () => {
  const profile = {
    id: "default",
    name: "Default",
    model: "plexus/gpt-5.6-terra",
    thinkingOptionId: "medium",
  };

  it("records the materialized launch settings when enabling a profile policy", () => {
    expect(createProfileToolPolicy(profile)).toMatchObject({
      profileId: "default",
      launchSignature: {
        model: "plexus/gpt-5.6-terra",
        mode: "",
        thinkingOption: "medium",
      },
    });
  });

  it("backfills missing signatures and prunes removed profiles", () => {
    const values = {
      piTools: { mode: "inherit" as const, allowedPatterns: [], blockedPatterns: [] },
      paseoTools: { enabled: true, disabledTools: [] },
      profilePolicies: [
        {
          profileId: "default",
          allowedPiToolNames: ["read"],
          allowedPaseoToolNames: ["create_agent"],
          allowedExternalMcpPatterns: [],
        },
        {
          profileId: "removed",
          allowedPiToolNames: [],
          allowedPaseoToolNames: [],
          allowedExternalMcpPatterns: [],
        },
      ],
    };

    expect(reconcileProfilePolicies(values, [profile])).toMatchObject({
      profilePolicies: [{
        profileId: "default",
        launchSignature: {
          model: "plexus/gpt-5.6-terra",
          mode: "",
          thinkingOption: "medium",
        },
      }],
    });
  });
});

describe("saveProfilePolicyWithRetry", () => {
  it("reloads and retries when a save returns false", async () => {
    const saves: boolean[] = [false, true];
    let reloads = 0;
    await saveProfilePolicyWithRetry(
      async () => saves.shift() ?? false,
      async () => { reloads += 1; },
      [0],
      async () => {},
    );
    expect(reloads).toBe(1);
  });

  it("surfaces rejected saves after bounded retries", async () => {
    let saves = 0;
    let reloads = 0;
    await expect(saveProfilePolicyWithRetry(
      async () => {
        saves += 1;
        throw new Error("revision conflict");
      },
      async () => { reloads += 1; },
      [0, 0],
      async () => {},
    )).rejects.toThrow("revision conflict");
    expect(saves).toBe(3);
    expect(reloads).toBe(2);
  });
});

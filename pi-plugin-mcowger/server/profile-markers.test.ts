import { describe, expect, it } from "vitest";

import {
  createPiProfileMarkerMaintainer,
  sanitizePiProfiles,
  type PiProfileConfig,
} from "./profile-markers.js";
import { PI_TOOL_POLICY_PROFILE_ID_SETTING } from "../shared/tool-policy.js";

function profile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Profile ${id}`,
    provider: "pi-plugin-mcowger",
    featureValues: { userSetting: "kept" },
    ...overrides,
  };
}

function configWith(initialProfiles: unknown[]): {
  config: PiProfileConfig;
  patched: unknown[][];
  state: { profiles: unknown[] };
} {
  const state = { profiles: initialProfiles };
  const patched: unknown[][] = [];
  return {
    state,
    patched,
    config: {
      get: async () => ({ config: { agentProfiles: state.profiles } }),
      patch: async ({ agentProfiles }) => {
        patched.push(agentProfiles);
        state.profiles = agentProfiles;
        return { config: { agentProfiles: state.profiles } };
      },
    },
  };
}

describe("sanitizePiProfiles", () => {
  it("returns only bounded, sanitized Pi profile presentation fields", () => {
    expect(sanitizePiProfiles([
      profile("pi-1", { notes: "notes", credential: "must not leak" }),
      { id: "other-1", name: "Other", provider: "other", featureValues: { secret: "nope" } },
      { id: "broken", provider: "pi-plugin-mcowger" },
      null,
    ])).toEqual([{
      id: "pi-1",
      name: "Profile pi-1",
      notes: "notes",
    }]);
  });

  it("keeps sanitized profile fields within the shared RPC limits", () => {
    const long = "x".repeat(300);
    expect(sanitizePiProfiles([profile(long, { name: long, model: long, notes: "x".repeat(5_000) })])).toEqual([{
      id: "x".repeat(160),
      name: "x".repeat(160),
      model: "x".repeat(160),
      notes: "x".repeat(4_000),
    }]);
  });
});

describe("createPiProfileMarkerMaintainer", () => {
  it("patches only Pi profile markers and preserves full profiles and feature values", async () => {
    const piProfile = profile("pi-1", {
      model: "plexus/model",
      featureValues: { userSetting: "kept", custom: { nested: true } },
      unknownProfileField: "preserved",
    });
    const otherProfile = {
      id: "other-1",
      name: "Other",
      provider: "other-provider",
      featureValues: { keep: "untouched" },
    };
    const { config, patched, state } = configWith([piProfile, otherProfile]);

    const result = await createPiProfileMarkerMaintainer().syncMarkers(config);

    expect(result).toMatchObject({ updated: 1, attempts: 1 });
    expect(patched).toHaveLength(1);
    expect(patched[0]?.[1]).toBe(otherProfile);
    expect(state.profiles[0]).toEqual({
      ...piProfile,
      featureValues: {
        userSetting: "kept",
        custom: { nested: true },
        [PI_TOOL_POLICY_PROFILE_ID_SETTING]: "pi-1",
      },
    });
  });

  it("re-reads before merging so a visible concurrent update is retained", async () => {
    const { config, patched, state } = configWith([profile("pi-1")]);
    const originalGet = config.get;
    let reads = 0;
    config.get = async () => {
      reads += 1;
      if (reads === 1) {
        state.profiles = [profile("pi-1", { featureValues: { changedElsewhere: true } })];
      }
      return originalGet();
    };

    await createPiProfileMarkerMaintainer().syncMarkers(config);

    expect(patched[0]?.[0]).toMatchObject({
      featureValues: {
        changedElsewhere: true,
        [PI_TOOL_POLICY_PROFILE_ID_SETTING]: "pi-1",
      },
    });
  });

  it("serializes concurrent syncs", async () => {
    const { config, patched } = configWith([profile("pi-1")]);
    let releasePatch: (() => void) | undefined;
    const patchStarted = new Promise<void>((resolve) => {
      const originalPatch = config.patch;
      config.patch = async (patch) => {
        resolve();
        await new Promise<void>((release) => {
          releasePatch = release;
        });
        return originalPatch(patch);
      };
    });
    const maintainer = createPiProfileMarkerMaintainer();
    const first = maintainer.syncMarkers(config);
    const second = maintainer.syncMarkers(config);

    await patchStarted;
    expect(patched).toHaveLength(0);
    releasePatch?.();
    await Promise.all([first, second]);

    expect(patched).toHaveLength(1);
  });

  it("does not confirm a patch when agentProfiles is absent", async () => {
    const { config } = configWith([profile("pi-1")]);
    let patchAttempts = 0;
    config.patch = async () => {
      patchAttempts += 1;
      return { config: {} };
    };

    await expect(createPiProfileMarkerMaintainer().syncMarkers(config)).rejects.toThrow(
      "synchronization could not be confirmed",
    );
    expect(patchAttempts).toBe(2);
  });

  it("fails when marker synchronization remains stale after retries", async () => {
    const { config } = configWith([profile("pi-1")]);
    config.patch = async () => ({ config: { agentProfiles: [profile("pi-1", {
      featureValues: { [PI_TOOL_POLICY_PROFILE_ID_SETTING]: "wrong" },
    })] } });

    await expect(createPiProfileMarkerMaintainer().syncMarkers(config)).rejects.toThrow(
      "synchronization could not be confirmed",
    );
  });

  it("retries once when a competing daemon update overwrites its patch", async () => {
    const { config, patched, state } = configWith([profile("pi-1")]);
    const originalPatch = config.patch;
    let patchCount = 0;
    config.patch = async (patch) => {
      patchCount += 1;
      const result = await originalPatch(patch);
      if (patchCount === 1) {
        state.profiles = [profile("pi-1", {
          featureValues: { changedElsewhere: "retained", [PI_TOOL_POLICY_PROFILE_ID_SETTING]: "wrong" },
        })];
      }
      return result;
    };

    const result = await createPiProfileMarkerMaintainer().syncMarkers(config);

    expect(result).toMatchObject({ attempts: 2, updated: 2 });
    expect(patched).toHaveLength(2);
    expect(patched[1]?.[0]).toMatchObject({
      featureValues: {
        changedElsewhere: "retained",
        [PI_TOOL_POLICY_PROFILE_ID_SETTING]: "pi-1",
      },
    });
  });
});

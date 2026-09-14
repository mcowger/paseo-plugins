import {
  MAX_PROFILE_ID_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROFILE_NOTES_LENGTH,
  PI_PROVIDER_ID,
  PI_TOOL_POLICY_PROFILE_ID_SETTING,
  type PiProfileSummary,
} from "../shared/tool-policy.js";

const MAX_PROFILE_VALUE_LENGTH = MAX_PROFILE_ID_LENGTH;
const MAX_MARKER_PATCH_ATTEMPTS = 2;

type UnknownRecord = Record<string, unknown>;

export interface PiProfileConfig {
  get(): Promise<{ config: { agentProfiles?: unknown[] } }>;
  patch(patch: { agentProfiles: unknown[] }): Promise<{ config: { agentProfiles?: unknown[] } }>;
}

export interface PiProfileMarkerSyncResult {
  profiles: PiProfileSummary[];
  updated: number;
  attempts: number;
}

export interface PiProfileMarkerMaintainer {
  listProfiles(config: PiProfileConfig): Promise<PiProfileSummary[]>;
  syncMarkers(config: PiProfileConfig): Promise<PiProfileMarkerSyncResult>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maximumLength) : undefined;
}

function profileId(profile: UnknownRecord): string | undefined {
  return boundedString(profile.id, MAX_PROFILE_ID_LENGTH);
}

function isPiProfile(profile: unknown): profile is UnknownRecord {
  return isRecord(profile) && profile.provider === PI_PROVIDER_ID && profileId(profile) !== undefined;
}

function summarizeProfile(profile: UnknownRecord): PiProfileSummary | undefined {
  const id = profileId(profile);
  const name = boundedString(profile.name, MAX_PROFILE_NAME_LENGTH);
  if (!id || !name) return undefined;

  return {
    id,
    name,
    ...(boundedString(profile.model, MAX_PROFILE_VALUE_LENGTH) ? { model: boundedString(profile.model, MAX_PROFILE_VALUE_LENGTH) } : {}),
    ...(boundedString(profile.modeId, MAX_PROFILE_VALUE_LENGTH) ? { modeId: boundedString(profile.modeId, MAX_PROFILE_VALUE_LENGTH) } : {}),
    ...(boundedString(profile.thinkingOptionId, MAX_PROFILE_VALUE_LENGTH)
      ? { thinkingOptionId: boundedString(profile.thinkingOptionId, MAX_PROFILE_VALUE_LENGTH) }
      : {}),
    ...(boundedString(profile.notes, MAX_PROFILE_NOTES_LENGTH) ? { notes: boundedString(profile.notes, MAX_PROFILE_NOTES_LENGTH) } : {}),
  };
}

export function sanitizePiProfiles(agentProfiles: readonly unknown[] | undefined): PiProfileSummary[] {
  return (agentProfiles ?? [])
    .filter(isPiProfile)
    .flatMap((profile) => {
      const summary = summarizeProfile(profile);
      return summary ? [summary] : [];
    });
}

function markerMatches(profile: UnknownRecord): boolean {
  const id = profileId(profile);
  return id !== undefined && isRecord(profile.featureValues) &&
    profile.featureValues[PI_TOOL_POLICY_PROFILE_ID_SETTING] === id;
}

function mergeProfileMarkers(agentProfiles: readonly unknown[]): {
  profiles: unknown[];
  updated: number;
} {
  let updated = 0;
  const profiles = agentProfiles.map((profile) => {
    if (!isPiProfile(profile) || markerMatches(profile)) return profile;
    updated += 1;
    return {
      ...profile,
      featureValues: {
        ...(isRecord(profile.featureValues) ? profile.featureValues : {}),
        [PI_TOOL_POLICY_PROFILE_ID_SETTING]: profileId(profile),
      },
    };
  });
  return { profiles, updated };
}

function markersCurrent(
  agentProfiles: readonly unknown[] | undefined,
  expectedProfileIds: readonly string[],
): boolean {
  if (!Array.isArray(agentProfiles)) return false;
  const profilesById = new Map(
    agentProfiles.filter(isPiProfile).map((profile) => [profileId(profile), profile]),
  );
  return expectedProfileIds.every((id) => {
    const profile = profilesById.get(id);
    return profile !== undefined && markerMatches(profile);
  });
}

export function createPiProfileMarkerMaintainer(): PiProfileMarkerMaintainer {
  let writes = Promise.resolve();

  const sync = async (config: PiProfileConfig): Promise<PiProfileMarkerSyncResult> => {
    let totalUpdated = 0;
    for (let attempt = 1; attempt <= MAX_MARKER_PATCH_ATTEMPTS; attempt += 1) {
      // Re-read on every attempt so the complete replacement list includes any
      // daemon changes visible immediately before this patch.
      const beforePatch = (await config.get()).config.agentProfiles ?? [];
      const merged = mergeProfileMarkers(beforePatch);
      totalUpdated += merged.updated;
      if (merged.updated === 0) {
        return {
          profiles: sanitizePiProfiles(beforePatch),
          updated: totalUpdated,
          attempts: attempt,
        };
      }

      await config.patch({ agentProfiles: merged.profiles });
      const afterPatch = (await config.get()).config.agentProfiles;
      const expectedProfileIds = merged.profiles
        .filter(isPiProfile)
        .map((profile) => profileId(profile))
        .filter((id): id is string => id !== undefined);
      if (markersCurrent(afterPatch, expectedProfileIds)) {
        return {
          profiles: sanitizePiProfiles(afterPatch),
          updated: totalUpdated,
          attempts: attempt,
        };
      }
    }

    throw new Error("Pi profile marker synchronization could not be confirmed; retrying is required.");
  };

  return {
    listProfiles: async (config) => sanitizePiProfiles((await config.get()).config.agentProfiles),
    syncMarkers: (config) => {
      const next = writes.then(() => sync(config), () => sync(config));
      writes = next.then(() => undefined, () => undefined);
      return next;
    },
  };
}

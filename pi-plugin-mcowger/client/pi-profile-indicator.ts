import type { PiProfileSummary } from "../shared/tool-policy.js";

export type PiProfileResolution =
  | { kind: "matched"; profile: PiProfileSummary }
  | { kind: "not-identified" }
  | { kind: "unknown" };

export function resolvePiProfile(
  profileId: string | null,
  profiles: readonly PiProfileSummary[],
): PiProfileResolution {
  if (profileId === null) return { kind: "not-identified" };
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return profile ? { kind: "matched", profile } : { kind: "unknown" };
}

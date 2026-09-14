import type {
  PiProfileSummary,
  PiToolPolicySettings,
  ProfileLaunchSignature,
  ProfileToolPolicy,
} from "../shared/tool-policy.js";

export const PROFILE_PRUNE_RETRY_DELAYS_MS = [0, 250, 1000] as const;

function launchSignatureFor(profile: PiProfileSummary): ProfileLaunchSignature | undefined {
  if (!profile.model) return undefined;
  return {
    model: profile.model,
    mode: profile.modeId ?? "",
    thinkingOption: profile.thinkingOptionId ?? "",
  };
}

function launchSignaturesEqual(
  left: ProfileLaunchSignature | undefined,
  right: ProfileLaunchSignature | undefined,
): boolean {
  return left?.model === right?.model &&
    left?.mode === right?.mode &&
    left?.thinkingOption === right?.thinkingOption;
}

export function withProfileLaunchSignature(
  policy: ProfileToolPolicy,
  profile: PiProfileSummary,
): ProfileToolPolicy {
  const launchSignature = launchSignatureFor(profile);
  if (launchSignaturesEqual(policy.launchSignature, launchSignature)) return policy;
  if (!launchSignature) {
    const { launchSignature: _removed, ...withoutSignature } = policy;
    return withoutSignature;
  }
  return { ...policy, launchSignature };
}

export function createProfileToolPolicy(profile: PiProfileSummary): ProfileToolPolicy {
  return withProfileLaunchSignature({
    profileId: profile.id,
    allowedPiToolNames: [],
    allowedPaseoToolNames: [],
    allowedExternalMcpPatterns: [],
  }, profile);
}

export function reconcileProfilePolicies(
  values: PiToolPolicySettings,
  profiles: readonly PiProfileSummary[],
): PiToolPolicySettings {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  let changed = false;
  const profilePolicies = values.profilePolicies.flatMap((policy) => {
    const profile = profilesById.get(policy.profileId);
    if (!profile) {
      changed = true;
      return [];
    }
    const next = withProfileLaunchSignature(policy, profile);
    if (next !== policy) changed = true;
    return [next];
  });
  return changed ? { ...values, profilePolicies } : values;
}

export async function saveProfilePolicyWithRetry(
  save: () => Promise<boolean>,
  reload: () => Promise<void>,
  retryDelays: readonly number[] = PROFILE_PRUNE_RETRY_DELAYS_MS,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<void> {
  let lastError: unknown = new Error("The profile policy cleanup was not saved");
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await wait(retryDelays[attempt - 1] ?? 0);
    try {
      if (await save()) return;
      lastError = new Error("The profile policy cleanup was not saved");
    } catch (error) {
      lastError = error;
    }
    if (attempt < retryDelays.length) await reload();
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

import {
  DEFAULT_PI_TOOL_POLICY_SETTINGS,
  type PiToolPolicy,
  type PiToolPolicySettings,
  type ProfileToolPolicy,
} from "../shared/tool-policy.js";
import { resolvePiToolPatterns } from "./tool-patterns.js";

export type { ProfileToolPolicy };

export interface BridgedMcpTool {
  piName: string;
  canonicalName: string;
  isPaseoTool: boolean;
}

export type ResolvedToolPolicy =
  | { source: "fallback"; policy: PiToolPolicy }
  | { source: "profile"; policy: ProfileToolPolicy };

export interface PiToolPolicyStoreSnapshot {
  settings: PiToolPolicySettings;
  revision: string | null;
}

export interface PiToolPolicyStore {
  snapshot(): PiToolPolicyStoreSnapshot;
  update(values: PiToolPolicySettings, revision: string, previousRevision: string | null): void;
}

function cloneSettings(settings: PiToolPolicySettings): PiToolPolicySettings {
  return {
    ...settings,
    piTools: {
      mode: settings.piTools.mode,
      allowedPatterns: [...settings.piTools.allowedPatterns],
      blockedPatterns: [...settings.piTools.blockedPatterns],
    },
    paseoTools: {
      enabled: settings.paseoTools.enabled,
      disabledTools: [...settings.paseoTools.disabledTools],
    },
    profilePolicies: settings.profilePolicies.map((policy) => ({
      profileId: policy.profileId,
      allowedPiToolNames: [...policy.allowedPiToolNames],
      allowedPaseoToolNames: [...policy.allowedPaseoToolNames],
      allowedExternalMcpPatterns: [...policy.allowedExternalMcpPatterns],
    })),
  };
}

export function createPiToolPolicyStore(): PiToolPolicyStore {
  let initialized = false;
  let current: PiToolPolicyStoreSnapshot = {
    settings: cloneSettings(DEFAULT_PI_TOOL_POLICY_SETTINGS),
    revision: null,
  };
  return {
    snapshot() {
      return { settings: cloneSettings(current.settings), revision: current.revision };
    },
    update(values, revision, previousRevision) {
      if (initialized && current.revision === revision) return;
      if (
        (previousRevision === null && initialized) ||
        (previousRevision !== null && (!initialized || previousRevision !== current.revision))
      ) {
        throw new Error("Pi tool policy settings changed before this sync completed");
      }
      initialized = true;
      current = { settings: cloneSettings(values), revision };
    },
  };
}

/**
 * Selects a complete profile rule only when its marker is an exact configured
 * profile ID. All malformed or unmatched markers retain the fallback policy.
 */
export function resolveConfiguredToolPolicy(
  marker: unknown,
  fallbackPolicy: PiToolPolicy,
  profilePolicies: readonly ProfileToolPolicy[] | undefined,
): ResolvedToolPolicy {
  if (typeof marker !== "string") return { source: "fallback", policy: fallbackPolicy };
  const profile = profilePolicies?.find((candidate) => candidate.profileId === marker);
  return profile
    ? { source: "profile", policy: profile }
    : { source: "fallback", policy: fallbackPolicy };
}

/**
 * Narrows the SDK's already-active catalog for a configured profile. It never
 * adds known-but-inactive tools and keeps the SDK's baseline ordering.
 */
export function resolveStrictActiveToolNames(
  baselineNames: readonly string[] | undefined,
  knownNames: readonly string[] | undefined,
  policy: ProfileToolPolicy,
  bridgeTools: readonly BridgedMcpTool[],
): string[] | undefined {
  if (baselineNames === undefined) return undefined;
  const known = new Set(knownNames ?? baselineNames);
  const allowedPiTools = new Set(policy.allowedPiToolNames);
  const allowedPaseoTools = new Set(policy.allowedPaseoToolNames);
  const allowedExternalTools = new Set(
    resolveExternalMcpToolNames(bridgeTools, policy.allowedExternalMcpPatterns),
  );
  const bridgeByPiName = new Map(bridgeTools.map((tool) => [tool.piName, tool]));

  return baselineNames.filter((name) => {
    if (!known.has(name)) return false;
    const bridgeTool = bridgeByPiName.get(name);
    if (!bridgeTool) return allowedPiTools.has(name);
    if (bridgeTool.isPaseoTool) return allowedPaseoTools.has(bridgeTool.canonicalName);
    return allowedExternalTools.has(name);
  });
}

/** Returns matching non-Paseo bridge names using the existing minimatch semantics. */
export function resolveExternalMcpToolNames(
  bridgeTools: readonly BridgedMcpTool[],
  patterns: readonly string[],
): string[] {
  const externalNames = bridgeTools
    .filter((tool) => !tool.isPaseoTool)
    .map((tool) => tool.piName);
  return resolvePiToolPatterns(externalNames, patterns);
}

export function resolvePiToolPolicy(
  baselineNames: readonly string[] | undefined,
  knownNames: readonly string[] | undefined,
  policy: PiToolPolicy,
): string[] | undefined {
  if (baselineNames === undefined) return undefined;
  const known = new Set(knownNames ?? baselineNames);
  const allowed =
    policy.mode === "allowlist"
      ? new Set(resolvePiToolPatterns(baselineNames, policy.allowedPatterns))
      : null;
  const blocked = new Set(resolvePiToolPatterns(baselineNames, policy.blockedPatterns));
  return baselineNames.filter(
    (name) => known.has(name) && (allowed === null || allowed.has(name)) && !blocked.has(name),
  );
}

export function piToolPolicyRequiresKnownBaseline(policy: PiToolPolicy): boolean {
  return policy.mode === "allowlist" || policy.blockedPatterns.length > 0;
}

export function filterPaseoToolNames(
  names: readonly string[],
  policy: PiToolPolicySettings["paseoTools"],
): string[] {
  if (!policy.enabled) return [];
  const disabled = new Set(policy.disabledTools);
  return names.filter((name) => !disabled.has(name));
}

/** Filters recognized Paseo canonical names with a complete profile allow set. */
export function filterPaseoToolNamesForProfile(
  names: readonly string[],
  allowedPaseoToolNames: readonly string[],
): string[] {
  const allowed = new Set(allowedPaseoToolNames);
  return names.filter((name) => allowed.has(name));
}

export function policyChanged(
  baselineNames: readonly string[],
  finalNames: readonly string[],
  paseoToolCount: number,
  visiblePaseoToolCount: number,
  policyEnabled: boolean,
): boolean {
  return (
    baselineNames.length !== finalNames.length ||
    paseoToolCount !== visiblePaseoToolCount ||
    (!policyEnabled && paseoToolCount > 0)
  );
}

export function formatPiToolPolicyDiagnostic(
  baselineNames: readonly string[],
  finalNames: readonly string[],
  allPaseoNames: readonly string[],
  visiblePaseoNames: readonly string[],
): string {
  const final = new Set(finalNames);
  const paseo = new Set(allPaseoNames);
  const visiblePaseo = new Set(visiblePaseoNames);
  const blockedPi = baselineNames.filter((name) => !final.has(name) && !paseo.has(name)).length;
  const blockedPaseo = baselineNames.filter(
    (name) => paseo.has(name) && !visiblePaseo.has(name) && !final.has(name),
  ).length;
  return `Pi tool policy: active tools ${baselineNames.length} -> ${finalNames.length}; blocked ${blockedPi} Pi tools and ${blockedPaseo} Paseo host tools.`;
}

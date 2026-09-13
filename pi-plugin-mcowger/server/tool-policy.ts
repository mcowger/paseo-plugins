import {
  DEFAULT_PI_TOOL_POLICY_SETTINGS,
  type PiToolPolicy,
  type PiToolPolicySettings,
} from "../shared/tool-policy.js";
import { resolvePiToolPatterns } from "./tool-patterns.js";

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
    piTools: {
      mode: settings.piTools.mode,
      allowedPatterns: [...settings.piTools.allowedPatterns],
      blockedPatterns: [...settings.piTools.blockedPatterns],
    },
    paseoTools: {
      enabled: settings.paseoTools.enabled,
      disabledTools: [...settings.paseoTools.disabledTools],
    },
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

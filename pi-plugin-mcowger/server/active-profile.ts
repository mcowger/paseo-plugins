import { piProfileIdSchema } from "../shared/tool-policy.js";

const PLUGIN_PERSISTENCE_PREFIX = "plugin:";

export function readActivePiProfileId(value: unknown): string | null {
  const parsed = piProfileIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function activePiProfileIdFromPersistenceData(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return readActivePiProfileId((value as { profileId?: unknown }).profileId);
}

export function activePiProfileIdFromRuntimeSessionId(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(PLUGIN_PERSISTENCE_PREFIX)) return null;
  try {
    const persistence = JSON.parse(value.slice(PLUGIN_PERSISTENCE_PREFIX.length)) as { data?: unknown };
    return activePiProfileIdFromPersistenceData(persistence.data);
  } catch {
    return null;
  }
}

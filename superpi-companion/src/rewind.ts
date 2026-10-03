import { PROTOCOL_VERSION, type RewindEntry } from "./protocol.ts";

/**
 * Minimal structural view of a Pi session entry. The companion only needs
 * `id`, `parentId`, `type`, and the message role to validate a rewind target;
 * keeping the shape narrow avoids depending on session internals.
 */
export interface BranchEntryLike {
  id: string;
  parentId?: string | null;
  type: string;
  message?: { role?: string };
}

export type RewindTargetResult =
  | { ok: true; entry: BranchEntryLike }
  | { ok: false; error: string };

/**
 * Validate the requested rewind target against the active branch.
 *
 * The target must be a user message on the current leaf path. Pi's public
 * `navigateTree` already implements before-selected-user semantics: a user
 * entry moves the leaf to its parent, so the companion passes the user entry
 * itself and never walks parents itself.
 */
export function findActiveBranchUserEntry(
  branch: readonly BranchEntryLike[],
  targetEntryId: string,
): RewindTargetResult {
  const entry = branch.find((candidate) => candidate.id === targetEntryId);
  if (!entry) {
    return { ok: false, error: "rewind target is not on the active branch" };
  }
  if (entry.type !== "message" || entry.message?.role !== "user") {
    return { ok: false, error: "rewind target must be an active-branch user message" };
  }
  return { ok: true, entry };
}

/** Branch pin appended after a successful rewind so reopen keeps the branch. */
export function buildRewindEntry(
  targetEntryId: string,
  leafId: string | null,
  timestamp: number,
): RewindEntry {
  return {
    version: PROTOCOL_VERSION,
    targetEntryId,
    ...(leafId !== null ? { leafId } : {}),
    timestamp,
  };
}

/** Pi's `navigateTree` result carries a `cancelled` flag when a hook vetoed it. */
export function navigationCancelled(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      (result as { cancelled?: unknown }).cancelled === true,
  );
}

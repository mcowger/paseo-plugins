export const MAX_CHILD_TIMELINE_ENTRIES = 8;

export interface TimelineEntryPosition {
  seqStart: number;
  seqEnd: number;
}

export function extractPaseoChildAgentId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const agentId = Reflect.get(value, "agentId");
  return typeof agentId === "string" && agentId.trim() ? agentId : undefined;
}

export function recentChildTimelineEntries<T extends TimelineEntryPosition>(
  entries: readonly T[],
): readonly T[] {
  return [...entries]
    .sort((left, right) => left.seqStart - right.seqStart)
    .slice(-MAX_CHILD_TIMELINE_ENTRIES);
}

export function childTimelineEntryKey(entry: TimelineEntryPosition): string {
  return `${entry.seqStart}-${entry.seqEnd}`;
}

import type { PaseoAgentStream, PaseoAgentTimelineEvent } from "@getpaseo/client";

/**
 * 0.8 re-subscribes an agent timeline on its own and announces the new epoch with a
 * replacement event. That event carries none of the stream fields, so every reader has
 * to branch on it before touching `timestamp`, `seq`, or `event.item`. Callers that
 * hold fetched history refetch when this returns false, because the replacement
 * invalidates what they already have.
 */
export function isAgentStream(event: PaseoAgentTimelineEvent): event is PaseoAgentStream {
  return event.event.type !== "replacement";
}

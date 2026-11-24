/**
 * Parent linkage for delegated (subagent) agents. Pure, unit-testable.
 *
 * Paseo marks delegated agents with the `paseo.parent-agent-id` label (the
 * same mechanism the app's Subagents popover uses); a dedicated snapshot
 * field is not delivered on the wire, so the label is the primary source and
 * the field only a defensive fallback.
 */

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export function parentAgentIdOf(agent: {
  labels?: Record<string, string> | null;
  parentAgentId?: string | null;
}): string | null {
  const labeled = agent.labels?.[PARENT_AGENT_ID_LABEL];
  if (typeof labeled === "string" && labeled.trim() !== "") return labeled.trim();
  const field = agent.parentAgentId;
  return typeof field === "string" && field.trim() !== "" ? field.trim() : null;
}

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Interrupts the active turn of an agent in this workspace. The agent stays
 * alive and idle afterwards; a later prompt resumes it. The plugin SDK exposes
 * no cancel call, so the server side of this RPC speaks the daemon session
 * protocol directly (see control.server.ts).
 */
export const cancelWorkspaceAgent = defineRpc({
  name: "super-tasks.agent.cancel",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    ok: z.boolean(),
    /** Daemon-reported refusal, for example when no turn is running. */
    error: z.string().nullable(),
  }),
});

export type CancelWorkspaceAgentInput = z.infer<typeof cancelWorkspaceAgent.input>;
export type CancelWorkspaceAgentOutput = z.infer<typeof cancelWorkspaceAgent.output>;

export const ProviderSubagentItemSchema = z.object({
  id: z.string(),
  parentAgentId: z.string(),
  provider: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  subtitle: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  toolCallId: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
});

export type ProviderSubagentItem = z.infer<typeof ProviderSubagentItemSchema>;

export const listWorkspaceProviderSubagents = defineRpc({
  name: "super-tasks.subagents.list",
  input: z.object({
    parentAgentIds: z.array(z.string().min(1)),
  }),
  output: z.object({
    subagents: z.array(ProviderSubagentItemSchema),
  }),
});

export type ListWorkspaceProviderSubagentsInput = z.infer<
  typeof listWorkspaceProviderSubagents.input
>;
export type ListWorkspaceProviderSubagentsOutput = z.infer<
  typeof listWorkspaceProviderSubagents.output
>;

export const ProviderSubagentTimelineEntrySchema = z.object({
  timestamp: z.string(),
  item: z.any(),
  seq: z.number().optional(),
});

export type ProviderSubagentTimelineEntry = z.infer<typeof ProviderSubagentTimelineEntrySchema>;

export const getProviderSubagentTimeline = defineRpc({
  name: "super-tasks.subagents.timeline",
  input: z.object({
    parentAgentId: z.string().min(1),
    subagentId: z.string().min(1),
    limit: z.number().int().positive().optional(),
  }),
  output: z.object({
    entries: z.array(ProviderSubagentTimelineEntrySchema),
  }),
});

export type GetProviderSubagentTimelineInput = z.infer<typeof getProviderSubagentTimeline.input>;
export type GetProviderSubagentTimelineOutput = z.infer<typeof getProviderSubagentTimeline.output>;

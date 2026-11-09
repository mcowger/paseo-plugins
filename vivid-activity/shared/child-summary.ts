import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Three display rows, with bounded text; tool outputs and Agent records stay on the daemon. */
export const childSummaryRowSchema = z.object({
  k: z.string().max(40),
  i: z.string().max(40),
  t: z.string().max(36),
  x: z.string().max(72).optional(),
  c: z.enum(["shell", "file", "search", "agent", "plan", "communication", "unknown", "reasoning", "failed"]),
  s: z.string().max(20).optional(),
});
export type ChildSummaryRow = z.output<typeof childSummaryRowSchema>;
export const childSummaryRpc = defineRpc({
  name: "child-summary",
  input: z.object({
    agentId: z.string().min(1).max(256),
    /** Explicit user action may load a closed child's history, as in 0.5.0. */
    manual: z.boolean().optional(),
    statusOnly: z.boolean().optional(),
    /** Paseo 0.13: the host `create_agent` put the child on (its result's `serverId`); this host's own id reads here. */
    serverId: z.string().min(1).max(256).optional(),
  }),
  output: z.object({
    /**
     * 0.6.0: unconfirmed: the daemon's status check failed, so whether the child is loaded is unknown and nothing was read.
     * 0.9.1: offline: the child runs on another host this daemon cannot reach now.
     */
    status: z.enum(["ok", "missing", "closed", "unconfirmed", "offline"]),
    /**
     * 0.10: `waiting`: the child waits for an approval or asks a question (its pending requests); `error`: the first line of its
     * error, masked, while it failed. Older servers send neither.
     */
    agent: z.object({ status: z.string().max(30), waiting: z.enum(["approval", "question"]).nullable().optional(), error: z.string().max(160).nullable().optional() }).nullable(),
    rows: z.array(childSummaryRowSchema).max(3),
    /** 0.9.1: the name of the other host the child runs on (Paseo 0.13 connected hosts); absent for a child on this host. */
    host: z.string().max(120).optional(),
  }),
});
export type ChildSummaryInput = z.input<typeof childSummaryRpc.input>;
export type ChildSummaryOutput = z.output<typeof childSummaryRpc.output>;

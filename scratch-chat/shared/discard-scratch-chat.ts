import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const discardScratchChatRpc = defineRpc({
  name: "discard-scratch-chat",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ agentId: z.string(), workspaceId: z.string() }),
});

export type DiscardScratchChatResult = z.output<typeof discardScratchChatRpc.output>;

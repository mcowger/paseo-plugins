import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const createScratchChatRpc = defineRpc({
  name: "create-scratch-chat",
  input: z.object({}),
  output: z.object({
    workspaceId: z.string(),
    agentId: z.string(),
  }),
});

export type CreateScratchChatResult = z.output<typeof createScratchChatRpc.output>;

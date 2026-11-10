import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ompMcpResultRpc = defineRpc({
  name: "omp-mcp-result",
  input: z.object({ agentId: z.string().min(1).max(256), callId: z.string().min(1).max(512) }).strict(),
  output: z.object({ text: z.string().nullable() }).strict(),
});

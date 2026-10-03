import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const resumeCommandRpc = defineRpc({
  name: "superpi.resume-command",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ command: z.string().min(1) }),
});

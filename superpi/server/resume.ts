import path from "node:path";
import type { ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { SessionStore } from "./persistence.js";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function buildResumeCommand(input: {
  stateDirectory: string;
  cwd: string;
  persistence: ProviderPersistence;
  command: string;
  companionPath: string;
  agentDirectory?: string;
}): Promise<string> {
  const transcript = await SessionStore.readTranscript(input.stateDirectory, input.cwd, input.persistence);
  if (!transcript) throw new Error("This session has no saved Pi transcript yet.");
  const environment = input.agentDirectory ? `PI_CODING_AGENT_DIR=${quote(input.agentDirectory)} ` : "";
  return `cd ${quote(input.cwd)} && ${environment}${quote(input.command)} --session ${quote(transcript)} --session-dir ${quote(path.dirname(transcript))} --extension ${quote(input.companionPath)} --superpi-companion-root`;
}

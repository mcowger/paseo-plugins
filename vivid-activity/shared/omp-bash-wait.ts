import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

/** Paseo projects an OMP background bash wait as a labeled plain-text result. */
export function ompBashWait(name: string, detail: ToolCallDetail | null | undefined): { command: string } | null {
  if (!/^(?:(?:functions|tools)\.)?wait$/i.test(name.trim()) || detail?.type !== "plain_text") return null;
  const match = detail.label?.match(/^bash (?:running|completed|failed|aborted|canceled):\s*([\s\S]+)$/i);
  return match?.[1]?.trim() ? { command: match[1].trim() } : null;
}

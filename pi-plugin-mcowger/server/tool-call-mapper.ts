import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

export type PiToolResult = string | { output?: string; stdout?: string; text?: string; content?: Array<{ type: string; text?: string }>; exitCode?: number; code?: number; details?: { diff?: string; server?: string; tool?: string; xdev?: unknown } } | null;
export type PiTrackedToolCall = { toolName: string; args: unknown };

export function parseToolArgs(toolName: string, args: unknown): PiTrackedToolCall { return { toolName, args }; }
export function parseToolResult(value: unknown): PiToolResult {
  if (typeof value === "string" || value === null) return value;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Exclude<PiToolResult, string | null> : null;
}
export function extractTextFromToolResult(result: PiToolResult): string | undefined {
  if (typeof result === "string") return result;
  if (!result) return undefined;
  return result.output ?? result.stdout ?? result.text ?? result.content?.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text!).join("\n");
}
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function resolveToolCallName(call: PiTrackedToolCall, result?: PiToolResult): string {
  if (call.toolName !== "mcp") return call.toolName;
  if (result && typeof result !== "string" && result.details?.server && result.details.tool) return `${result.details.server}.${result.details.tool}`;
  const args = record(call.args);
  const server = typeof args.server === "string" ? args.server : undefined;
  const tool = typeof args.tool === "string" ? args.tool : undefined;
  return server && tool ? `${server}.${tool.replace(`${server}_`, "")}` : call.toolName;
}
export function mapToolDetail(call: PiTrackedToolCall, result?: PiToolResult): ProviderToolCallDetail {
  const args = record(call.args);
  switch (call.toolName) {
    case "bash": return { type: "shell", command: typeof args.command === "string" ? args.command : "", output: extractTextFromToolResult(result ?? null), exitCode: result && typeof result !== "string" ? result.exitCode ?? result.code ?? null : null };
    case "read": return { type: "read", filePath: typeof args.path === "string" ? args.path : "", content: extractTextFromToolResult(result ?? null), ...(typeof args.offset === "number" ? { offset: args.offset } : {}), ...(typeof args.limit === "number" ? { limit: args.limit } : {}) };
    case "edit": { const edit = Array.isArray(args.edits) ? record(args.edits[0]) : args; return { type: "edit", filePath: typeof args.path === "string" ? args.path : "", ...(typeof (edit.oldText ?? edit.old_string) === "string" ? { oldString: String(edit.oldText ?? edit.old_string) } : {}), ...(typeof (edit.newText ?? edit.new_string) === "string" ? { newString: String(edit.newText ?? edit.new_string) } : {}), ...(result && typeof result !== "string" && typeof result.details?.diff === "string" ? { unifiedDiff: result.details.diff } : {}) }; }
    case "write": return { type: "write", filePath: typeof args.path === "string" ? args.path : "", ...(typeof args.content === "string" ? { content: args.content } : {}) };
    case "find": return { type: "search", query: typeof args.pattern === "string" ? args.pattern : "", toolName: "search", content: extractTextFromToolResult(result ?? null) };
    case "grep": return { type: "search", query: typeof args.pattern === "string" ? args.pattern : "", toolName: "grep", content: extractTextFromToolResult(result ?? null) };
    case "task": case "subagent": return { type: "sub_agent", ...(typeof args.agent === "string" ? { subAgentType: args.agent } : {}), ...(typeof args.task === "string" ? { description: args.task } : {}), log: extractTextFromToolResult(result ?? null) ?? "" };
    default: return { type: "unknown", input: call.args as never, output: result as never };
  }
}

import { extractPiToolText } from "./presentation";

export function isMcpTool(name: string): boolean {
  return /^mcp_/i.test(name.trim());
}

export function mcpResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const part of [record.text, record.stdout, record.output]) {
    if (typeof part === "string" && part) return part;
  }
  return extractPiToolText(record)?.text || (record.output && typeof record.output === "object" ? mcpResultText(record.output) : undefined);
}

import { minimatch } from "minimatch";

export function hasPiToolGlob(pattern: string): boolean {
  return (
    pattern.includes("*") ||
    pattern.includes("?") ||
    pattern.includes("[") ||
    pattern.includes("{")
  );
}

export function resolvePiToolPatterns(
  toolNames: readonly string[],
  patterns: readonly string[],
): string[] {
  const normalizedPatterns = patterns.map((pattern) => pattern.trim()).filter(Boolean);
  if (normalizedPatterns.length === 0) {
    return [];
  }
  return toolNames.filter((toolName) =>
    normalizedPatterns.some((pattern) => minimatch(toolName, pattern, { nonegate: true })),
  );
}

import { formatToolDetailDiagnostic, type ToolDetailDiagnostic } from "./timeline.js";

/**
 * Writes a tool-detail diagnostic to the plugin log.
 *
 * `timeline.ts` stays pure, so the log call lives here. Key names only: this
 * exists to say which structured facts nothing interprets, and to make a tool
 * that deserves a parser visible in `paseo plugin logs plexuspi` instead of
 * silent.
 */
export function logToolDetailDiagnostic(diagnostic: ToolDetailDiagnostic): void {
  console.info(`[plexuspi] ${formatToolDetailDiagnostic(diagnostic)}`);
}

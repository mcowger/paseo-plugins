import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompanion } from "./src/companion.ts";

export {
  createCompanion,
  COMPANION_CAPABILITIES,
  type CompanionHandle,
  type CompanionOptions,
} from "./src/companion.ts";
export { createSubagentBridgeTracker, formatChildForward, type SubagentBridgeTracker } from "./src/bridge.ts";
export { detectControlConflicts, KNOWN_CONTROL_OWNERS } from "./src/conflicts.ts";
export { EXPANDED_CONTEXT_WINDOW } from "./src/context.ts";
export { buildRewindEntry, findActiveBranchUserEntry, navigationCancelled } from "./src/rewind.ts";
export {
  CHILD_NOTIFY_PREFIX,
  COMMAND_NAME,
  CompactDataSchema,
  ConfigureDataSchema,
  CUSTOM_ENTRY_TYPE,
  NOTIFY_PREFIX,
  parseRequestArg,
  PROTOCOL_VERSION,
  REWIND_ENTRY_TYPE,
  RewindDataSchema,
  RewindEntrySchema,
  RewindResultSchema,
  ROOT_FLAG,
  SESSION_KEY_ENV,
  SUBAGENT_BRIDGE_CHANNEL,
  SUBAGENT_BRIDGE_VERSION,
  SubagentBridgeRecordSchema,
  SuperpiRequestSchema,
  SuperpiReplySchema,
  SuperpiStateSchema,
  TierSchema,
} from "./src/protocol.ts";

/**
 * Superpi companion Pi extension. The provider launches the root Pi with
 * `--superpi-companion-root` and `SUPERPI_SESSION_KEY`; controls travel through
 * `/superpi-control <base64url JSON>` and replies through `ctx.ui.notify`.
 */
export default function superpiCompanion(pi: ExtensionAPI): void {
  createCompanion(pi);
}

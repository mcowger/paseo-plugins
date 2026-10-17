import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompanion } from "./src/companion.ts";

export {
  createSubagentBridgeTracker,
  formatChildForward,
  type SubagentBridgeTracker,
} from "./src/bridge.ts";
export {
  COMPANION_CAPABILITIES,
  type CompanionHandle,
  type CompanionOptions,
  createCompanion,
} from "./src/companion.ts";
export { detectControlConflicts, KNOWN_CONTROL_OWNERS } from "./src/conflicts.ts";
export {
  CHILD_NOTIFY_PREFIX,
  COMMAND_NAME,
  CompactDataSchema,
  ConfigureDataSchema,
  CUSTOM_ENTRY_TYPE,
  NOTIFY_PREFIX,
  PROTOCOL_VERSION,
  parseRequestArg,
  REWIND_ENTRY_TYPE,
  RewindDataSchema,
  RewindEntrySchema,
  RewindResultSchema,
  ROOT_FLAG,
  SESSION_KEY_ENV,
  SUBAGENT_BRIDGE_CHANNEL,
  SUBAGENT_BRIDGE_VERSION,
  SubagentBridgeRecordSchema,
  SuperpiReplySchema,
  SuperpiRequestSchema,
  SuperpiStateSchema,
  TierSchema,
} from "./src/protocol.ts";
export { buildRewindEntry, findActiveBranchUserEntry, navigationCancelled } from "./src/rewind.ts";

/**
 * Superpi companion Pi extension. The provider launches the root Pi with
 * `--superpi-companion-root` and `SUPERPI_SESSION_KEY`; controls travel through
 * `/superpi-control <base64url JSON>` and replies through `ctx.ui.notify`.
 */
export default function superpiCompanion(pi: ExtensionAPI): void {
  createCompanion(pi);
}

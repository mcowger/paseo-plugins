import type { Conflict } from "./protocol.ts";

interface KnownControlOwner {
  readonly owner: string;
  readonly commands: readonly string[];
  readonly resolution: string;
}

/**
 * Extensions that are known to own tier/context request payloads. We only fail
 * the handshake when one of these owners has actually declared its control
 * command, not merely because a provider factory is loaded.
 */
export const KNOWN_CONTROL_OWNERS: readonly KnownControlOwner[] = [
  {
    owner: "plexus-pi",
    commands: ["service-tier"],
    resolution:
      "Disable plexus-pi's /service-tier command for this Superpi root so the companion owns tier selection.",
  },
  {
    owner: "pi-microgpt",
    commands: ["fast", "flex", "long-context"],
    resolution:
      "Disable pi-microgpt's /fast, /flex, and /long-context commands for this Superpi root so the companion owns tier and context selection.",
  },
];

export interface DeclaredCommand {
  name: string;
  source?: string;
}

/**
 * Detect declared control owners from the session command list. Commands
 * without a `source` are treated as extension commands so tests can supply
 * minimal fixtures.
 */
export function detectControlConflicts(commands: readonly DeclaredCommand[]): Conflict[] {
  const declared = new Set(
    commands
      .filter((command) => command.source === undefined || command.source === "extension")
      .map((command) => command.name),
  );

  const conflicts: Conflict[] = [];
  for (const known of KNOWN_CONTROL_OWNERS) {
    const matched = known.commands.filter((command) => declared.has(command));
    if (matched.length > 0) {
      conflicts.push({ owner: known.owner, command: matched.join(", "), resolution: known.resolution });
    }
  }
  return conflicts;
}

import type { ProviderCommand } from "@getpaseo/plugin/server/provider";

import type { PiPromptTemplateLike } from "../shared/pi-sdk-types.js";

export interface PiExtensionCommandLike {
  name: string;
  description?: string;
}

export interface PiExtensionCommandsLike {
  commands: ReadonlyMap<string, PiExtensionCommandLike>;
}

const BUILTIN_COMMANDS: readonly ProviderCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
  },
  {
    name: "preset",
    description: "Activate a pi preset",
    argumentHint: "<name>",
  },
];

function addCommand(
  commands: ProviderCommand[],
  names: Set<string>,
  command: ProviderCommand,
): void {
  const name = command.name.trim();
  if (!name || names.has(name)) return;
  names.add(name);
  commands.push({ ...command, name });
}

export function buildPiPromptCommands(
  extensions: readonly PiExtensionCommandsLike[],
  prompts: readonly PiPromptTemplateLike[],
): ProviderCommand[] {
  const commands: ProviderCommand[] = [];
  const names = new Set<string>();

  for (const command of BUILTIN_COMMANDS) {
    addCommand(commands, names, command);
  }

  for (const extension of extensions) {
    for (const [registeredName, command] of extension.commands) {
      const name = command.name.trim() || registeredName.trim();
      addCommand(commands, names, {
        name,
        description: command.description?.trim() || "Pi extension command",
      });
    }
  }

  for (const prompt of prompts) {
    addCommand(commands, names, {
      name: prompt.name,
      description: prompt.description?.trim() || "Prompt template",
    });
  }

  return commands;
}

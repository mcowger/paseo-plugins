import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { createPaseoExtension } from "./session.js";

test("writes an importable Pi extension", async () => {
  const extension = createPaseoExtension("Paseo system prompt");
  try {
    const module = await import(pathToFileURL(extension.path).href) as {
      default: (pi: { on(event: string, handler: (event: { systemPrompt: string }) => unknown): void; registerCommand(name: string, command: unknown): void }) => void;
    };
    const listeners = new Map<string, (event: { systemPrompt: string }) => unknown>();
    const commands = new Map<string, unknown>();
    module.default({
      on: (event, handler) => listeners.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
    });
    expect(await listeners.get("before_agent_start")?.({ systemPrompt: "Pi prompt" })).toEqual({
      systemPrompt: "Pi prompt\n\nPaseo system prompt",
    });
    expect(commands.get("paseo_tree")).toBeDefined();
  } finally {
    extension.cleanup();
  }
});

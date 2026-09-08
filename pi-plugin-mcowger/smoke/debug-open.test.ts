/**
 * Debug reproduction of the daemon's draft session open:
 * version probe → MCP adapter probe → extension file → startSession → getState.
 * Run: npx vitest run --config vitest.smoke.config.ts -t "debug open"
 */
import { describe, expect, it } from "vitest";

import { createPiPaseoExtensionFile } from "../server/extension.js";
import { PiCliRuntime } from "../server/runtime.js";

const CWD = "/home/matt.cowger/workspace/paseo-plugins";

describe("debug open", () => {
  it("mirrors handleSessionOpen", async () => {
    const runtime = new PiCliRuntime();

    console.log("step: version probe");
    const version = await runtime.probeVersion();
    console.log("version:", version);

    console.log("step: mcp adapter probe (startSession + getCommands)");
    const probe = await runtime.startSession({ cwd: CWD, noSession: true });
    const commands = await probe.getCommands();
    console.log("probe commands:", commands.length);
    await probe.close();
    console.log("probe closed");

    const extension = createPiPaseoExtensionFile("test system prompt");
    try {
      console.log("step: startSession with model + extension");
      const session = await runtime.startSession({
        cwd: CWD,
        model: "plexus/kimi-k3",
        noSession: true,
        extensionPaths: [extension.path],
      });
      console.log("step: getState");
      const state = await session.getState();
      console.log("state:", state.model?.provider, state.model?.id, state.thinkingLevel);
      console.log("step: getAvailableModels");
      const models = await session.getAvailableModels(null);
      console.log("models:", models.length);
      console.log("step: getCommands");
      const cmds = await session.getCommands();
      console.log("commands:", cmds.length);
      await session.close();
      console.log("session closed");
    } finally {
      extension.cleanup();
    }
    expect(true).toBe(true);
  }, 90_000);
});

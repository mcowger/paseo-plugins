import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { modelMatchesPatterns, readPiUserSettings } from "./pi-settings.js";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-settings-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("readPiUserSettings", () => {
  it("reads global settings with project overrides", () => {
    const agentDir = makeDir();
    const cwd = makeDir();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        enabledProviders: ["plexus"],
        defaultProvider: "plexus",
        defaultModel: "muse-spark-1.3",
        defaultThinkingLevel: "max",
        modelThinkingLevels: { "plexus/gpt-5.6-luna": "max" },
      }),
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ defaultThinkingLevel: "high", enabledModels: ["plexus/gpt-5.6-*"] }),
    );

    const settings = readPiUserSettings(cwd, { PI_CODING_AGENT_DIR: agentDir });
    expect(settings.defaultProvider).toBe("plexus");
    expect(settings.defaultModel).toBe("muse-spark-1.3");
    expect(settings.defaultThinkingLevel).toBe("high");
    expect(settings.enabledModels).toEqual(["plexus/gpt-5.6-*"]);
    expect(settings.modelThinkingLevels).toEqual({ "plexus/gpt-5.6-luna": "max" });
  });

  it("tolerates missing and malformed files", () => {
    const agentDir = makeDir();
    writeFileSync(join(agentDir, "settings.json"), "nope{");
    const settings = readPiUserSettings(makeDir(), { PI_CODING_AGENT_DIR: agentDir });
    expect(settings.defaultModel).toBeUndefined();
  });
});

describe("modelMatchesPatterns", () => {
  it("matches exact ids case-insensitively", () => {
    expect(modelMatchesPatterns("plexus/kimi-k3", ["Plexus/Kimi-K3"])).toBe(true);
    expect(modelMatchesPatterns("plexus/kimi-k3", ["openai/gpt-5"])).toBe(false);
  });

  it("supports wildcards and per-pattern thinking suffixes", () => {
    expect(modelMatchesPatterns("plexus/gpt-5.6-sol", ["plexus/*"])).toBe(true);
    expect(modelMatchesPatterns("anthropic/claude-opus-5", ["*:max"])).toBe(true);
    expect(modelMatchesPatterns("anthropic/claude-opus-5", ["anthropic/*:high"])).toBe(true);
    expect(modelMatchesPatterns("anthropic/claude-opus-5", ["plexus/*:high"])).toBe(false);
    // Non-thinking colons are not stripped as suffixes
    expect(modelMatchesPatterns("x/y:z", ["x/y:z"])).toBe(true);
  });
});

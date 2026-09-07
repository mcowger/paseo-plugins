import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadPiPresets, presetsToModes, readActivePresetName } from "./presets.js";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-presets-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("loadPiPresets", () => {
  it("merges project presets over global presets", () => {
    const agentDir = makeDir();
    const cwd = makeDir();
    writeFileSync(
      join(agentDir, "presets.json"),
      JSON.stringify({
        plan: { provider: "openai", model: "gpt-5.2", thinkingLevel: "high" },
        implement: { provider: "anthropic", model: "claude-sonnet-4-5" },
      }),
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "presets.json"),
      JSON.stringify({ plan: { provider: "local", model: "override" } }),
    );

    const presets = loadPiPresets(cwd, { PI_CODING_AGENT_DIR: agentDir });
    expect(Object.keys(presets).sort()).toEqual(["implement", "plan"]);
    expect(presets.plan.provider).toBe("local");
    expect(presets.implement.model).toBe("claude-sonnet-4-5");
  });

  it("returns empty when no files exist or files are malformed", () => {
    const agentDir = makeDir();
    const cwd = makeDir();
    writeFileSync(join(agentDir, "presets.json"), "not json{");
    expect(loadPiPresets(cwd, { PI_CODING_AGENT_DIR: agentDir })).toEqual({});
    expect(loadPiPresets(makeDir(), { PI_CODING_AGENT_DIR: makeDir() })).toEqual({});
  });
});

describe("presetsToModes", () => {
  it("maps presets to provider modes", () => {
    const modes = presetsToModes({
      plan: { provider: "openai", model: "gpt-5.2", thinkingLevel: "high" },
      implement: { model: "claude-sonnet-4-5" },
    });
    expect(modes).toEqual([
      {
        id: "plan",
        label: "Plan",
        icon: "Bot",
        description: "openai/gpt-5.2 · thinking: high",
      },
      { id: "implement", label: "Implement", icon: "Bot", description: "claude-sonnet-4-5" },
    ]);
  });
});

describe("readActivePresetName", () => {
  it("returns the latest preset-state entry name", () => {
    const entries = [
      { type: "message" },
      { type: "custom", customType: "preset-state", data: { name: "plan" } },
      { type: "custom", customType: "other", data: { name: "nope" } },
      { type: "custom", customType: "preset-state", data: { name: "implement" } },
    ];
    expect(readActivePresetName(entries)).toBe("implement");
  });

  it("returns null when no preset-state entries exist", () => {
    expect(readActivePresetName([{ type: "message" }])).toBeNull();
    expect(readActivePresetName(null)).toBeNull();
    expect(
      readActivePresetName([{ type: "custom", customType: "preset-state", data: {} }]),
    ).toBeNull();
  });
});

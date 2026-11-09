import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { basesFromConfig, createProviderBases, daemonHome, readDaemonConfig } from "./provider-base";

describe("which built-in provider an Agent's provider is built on (0.8.0)", () => {
  const config = { agents: { providers: { claude: { enabled: false }, "my-claude": { extends: "claude", label: "Mine", env: { TOKEN: "secret" } }, "work-codex": { extends: "codex" }, "bad id!": { extends: "claude" }, odd: { extends: 42 } } } };

  it("keeps only the extends of valid custom ids", () => {
    expect([...basesFromConfig(config)]).toEqual([["my-claude", "claude"], ["work-codex", "codex"]]);
    expect(basesFromConfig(null).size).toBe(0);
    expect(basesFromConfig({ agents: { providers: [] } }).size).toBe(0);
  });

  it("maps custom ids to their base, built-ins to themselves, anything else to null", async () => {
    let reads = 0;
    let now = 0;
    const baseOf = createProviderBases({ read: async () => (reads++, JSON.stringify(config)), now: () => now, ttlMs: 1000 });
    expect(await baseOf("my-claude")).toBe("claude");
    expect(await baseOf("work-codex")).toBe("codex");
    expect(await baseOf("claude")).toBe("claude");
    expect(await baseOf("acp")).toBe("acp");
    expect(await baseOf("unknown")).toBeNull();
    expect(await baseOf("")).toBeNull();
    expect(reads).toBe(1);
    now = 1500;
    await baseOf("my-claude");
    expect(reads).toBe(2);
  });

  it("treats a missing or broken config as having no custom providers", async () => {
    expect(await createProviderBases({ read: async () => null })("my-claude")).toBeNull();
    expect(await createProviderBases({ read: async () => "{not json" })("codex")).toBe("codex");
    expect(await createProviderBases({ read: async () => { throw new Error("EACCES"); } })("my-claude")).toBeNull();
  });

  it("reads the daemon's config.json under PASEO_HOME, and refuses one that is too large", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vivid-config-"));
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify(config));
      expect(daemonHome({ PASEO_HOME: dir }, "/home/user")).toBe(dir);
      expect(daemonHome({}, "/home/user")).toBe("/home/user/.paseo");
      expect(JSON.parse((await readDaemonConfig({ PASEO_HOME: dir }))!)).toEqual(config);
      expect(await readDaemonConfig({ PASEO_HOME: join(dir, "missing") })).toBeNull();
      writeFileSync(join(dir, "config.json"), " ".repeat(4 * 1024 * 1024 + 1));
      expect(await readDaemonConfig({ PASEO_HOME: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

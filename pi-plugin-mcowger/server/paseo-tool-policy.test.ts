import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isPaseoToolAllowed, readPiPaseoToolPolicy } from "./paseo-tool-policy.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Pi Paseo-tool policy", () => {
  it("reads the built-in pi provider policy from Paseo config", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-paseo-policy-"));
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          agents: {
            providers: {
              pi: {
                paseoTools: {
                  enabled: true,
                  disabledTools: ["create_workspace", "list_providers"],
                },
              },
            },
          },
        }),
      );
      vi.stubEnv("PASEO_HOME", home);

      const policy = readPiPaseoToolPolicy();

      expect(policy.enabled).toBe(true);
      expect(isPaseoToolAllowed(policy, "create_workspace")).toBe(false);
      expect(isPaseoToolAllowed(policy, "list_agents")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("defaults to the enabled catalog when Paseo config is unavailable", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-paseo-policy-"));
    try {
      vi.stubEnv("PASEO_HOME", home);

      const policy = readPiPaseoToolPolicy();

      expect(policy.enabled).toBe(true);
      expect(isPaseoToolAllowed(policy, "create_workspace")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("disables the whole catalog when pi disables Paseo tools", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-paseo-policy-"));
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ agents: { providers: { pi: { paseoTools: { enabled: false } } } } }),
      );
      vi.stubEnv("PASEO_HOME", home);

      const policy = readPiPaseoToolPolicy();

      expect(policy.enabled).toBe(false);
      expect(isPaseoToolAllowed(policy, "list_agents")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

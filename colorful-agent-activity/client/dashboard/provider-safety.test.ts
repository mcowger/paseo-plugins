import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Paseo only provides agent and workspace state inside a timeline, popover, or
 * workspace panel; `useAgent` throws "Plugin state hooks must run inside a
 * workspace panel" anywhere else, which is exactly what a plugin screen is.
 *
 * The dashboard previews real renderers inside a screen, so this guards the two
 * rules that keep that safe: the agent lookup lives in its own boundary
 * component, and the preview opts out of it.
 *
 * Structural on purpose: rendering React Native components in Node would not
 * reproduce the host's provider tree, and the crash is about that tree.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(path.resolve(here, relative), "utf8");

describe("agent state boundaries", () => {
  it("only calls useAgent from the AgentCwd boundary in the activity renderers", () => {
    const source = read("../activity.tsx");
    const calls = source
      .split("\n")
      .filter((line) => line.includes("useAgent(") && !line.trimStart().startsWith("import"));
    expect(calls).toHaveLength(1);
    const boundary = source.slice(source.indexOf("function AgentCwd"));
    const body = boundary.slice(0, boundary.indexOf("\n}\n"));
    expect(body).toContain("useAgent(");
  });

  it("never mounts agent state from the dashboard preview", () => {
    const source = read("./preview.tsx");
    expect(source).not.toContain("useAgent(");
    expect(source).not.toContain("useWorkspace(");
    // Every tool row the preview draws opts out of the agent lookup.
    const rows = source.match(/<ColorfulToolCall[^>]*>/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain("preview");
  });

  it("keeps the dashboard shell free of panel-only hooks", () => {
    for (const file of ["./index.tsx", "./controls.tsx", "./pages.tsx", "./sidebar.tsx"]) {
      const source = read(file);
      expect(source).not.toContain("useAgent(");
      expect(source).not.toContain("useWorkspace(");
    }
  });
});

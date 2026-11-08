import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Paseo compiles the plugin on the daemon host after `npm ci --omit=dev`, and every import, type-only ones included,
// must resolve there. So a bare import in the plugin's own source has to be a host-provided module or a runtime
// dependency in package.json; and a runtime dependency that nothing imports is an install the user pays for for nothing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_MODULES = /^(?:@getpaseo\/plugin(?:\/.*)?|react(?:\/.*)?|react-native(?:\/.*)?|@tanstack\/react-query|zod|node:.*)$/;

function sourceFiles(): string[] {
  const files = ["index.client.tsx", "index.server.ts"];
  for (const dir of ["client", "server", "shared"]) {
    for (const name of readdirSync(path.join(root, dir))) {
      if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

function bareImports(file: string): string[] {
  const text = readFileSync(path.join(root, file), "utf8");
  const specifiers = [...text.matchAll(/(?:^|\s)(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|(?:^|\s)import\s*["']([^"']+)["']/g)]
    .map((match) => match[1] ?? match[2]!);
  return specifiers.filter((specifier) => !specifier.startsWith("."));
}

const packageName = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

describe("runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const runtime = new Set(Object.keys(pkg.dependencies ?? {}));
  const imported = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    for (const specifier of bareImports(file)) {
      if (HOST_MODULES.test(specifier)) continue;
      const name = packageName(specifier);
      imported.set(name, [...(imported.get(name) ?? []), file]);
    }
  }

  it("imports only host modules and declared runtime dependencies", () => {
    const missing = [...imported].filter(([name]) => !runtime.has(name)).map(([name, files]) => `${name} (${files.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("declares no runtime dependency the source does not import", () => {
    expect([...runtime].filter((name) => !imported.has(name))).toEqual([]);
  });

  it("keeps @getpaseo/client a development dependency: its agent types come from the host SDK", () => {
    expect(runtime.has("@getpaseo/client")).toBe(false);
    expect(imported.has("@getpaseo/client")).toBe(false);
  });
});

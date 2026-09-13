import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(directory, "../index.client.tsx");
const externals = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
];

function resolveHermesc(): string | null {
  const sdkDir = path.resolve(directory, "../node_modules/react-native/sdks/hermesc");
  const binary =
    process.platform === "linux" && process.arch === "x64"
      ? path.join(sdkDir, "linux64-bin/hermesc")
      : process.platform === "darwin"
        ? path.join(sdkDir, "osx-bin/hermesc")
        : process.platform === "win32" && process.arch === "x64"
          ? path.join(sdkDir, "win64-bin/hermesc.exe")
          : null;
  return binary && existsSync(binary) ? binary : null;
}

async function bundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    jsx: "automatic",
    supported: { "async-await": false },
    external: externals,
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error("Client bundle compilation produced empty output");
  return output;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

describe("Theme Studio client bundle", () => {
  it("stays within the mobile bundle budget", async () => {
    expect((await bundle()).length).toBeLessThan(350 * 1024);
  });

  it("contains no unlowered classes", async () => {
    expect(stripComments(await bundle())).not.toMatch(/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/);
  });

  it("compiles with Hermes when hermesc is available", async () => {
    const hermesc = resolveHermesc();
    if (!hermesc) return;
    const name = `theme-studio-${Date.now()}`;
    const source = path.join(os.tmpdir(), `${name}.js`);
    const bytecode = path.join(os.tmpdir(), `${name}.hbc`);
    try {
      writeFileSync(source, await bundle(), "utf8");
      execFileSync(hermesc, ["-w", "-emit-binary", "-out", bytecode, source]);
      expect(existsSync(bytecode)).toBe(true);
    } finally {
      rmSync(source, { force: true });
      rmSync(bytecode, { force: true });
    }
  });
});

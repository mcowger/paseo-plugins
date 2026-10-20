import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * Mobile Hermes guard.
 *
 * Paseo compiles the client entry with esbuild (`es2020`, CJS, no Babel lowering) and `eval()`s the
 * result on iOS/Android. Unlowered class syntax and oversized bundles fail there and the plugin is
 * dropped for the session, so the same compile is reproduced here and checked in CI.
 *
 * Mirrors `colorful-agent-activity/client/bundle.test.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(here, "../index.client.tsx");

const PLUGIN_SDK_SPECIFIERS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
];

const SIZE_BUDGET_KB = 320;

function resolveHermesc(): string | null {
  const sdkDir = path.resolve(here, "../node_modules/react-native/sdks/hermesc");
  const platform = os.platform();
  const arch = os.arch();

  let binaryPath: string;
  if (platform === "linux" && arch === "x64") binaryPath = path.join(sdkDir, "linux64-bin/hermesc");
  else if (platform === "darwin") binaryPath = path.join(sdkDir, "osx-bin/hermesc");
  else if (platform === "win32" && arch === "x64")
    binaryPath = path.join(sdkDir, "win64-bin/hermesc.exe");
  else return null;

  return existsSync(binaryPath) ? binaryPath : null;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

function makeHermesInteropEager(code: string): string {
  return code.replaceAll("get: () => from[key]", "value: from[key]");
}

function wrapCommonJsBundle(code: string): string {
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}

async function compileClientBundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    supported: { "async-await": false },
    external: [
      ...PLUGIN_SDK_SPECIFIERS,
      "@tanstack/react-query",
      "react",
      "react/jsx-runtime",
      "react-native",
      "zod",
    ],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });

  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error("Client bundle compilation produced empty output");
  return wrapCommonJsBundle(makeHermesInteropEager(output));
}

describe("client mobile bundle compatibility", () => {
  it("bundles index.client.tsx within the mobile size budget", async () => {
    const bundle = await compileClientBundle();
    expect(Math.round(bundle.length / 1024)).toBeLessThan(SIZE_BUDGET_KB);
  });

  it("contains no ES6 classes", async () => {
    const bundle = await compileClientBundle();
    const classMatches: string[] = [];
    for (const [index, line] of stripComments(bundle).split("\n").entries()) {
      if (/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/.test(line)) {
        classMatches.push(`Line ${index + 1}: ${line.trim()}`);
      }
    }
    expect(classMatches).toEqual([]);
  });

  it("compiles to Hermes bytecode", async () => {
    const hermesc = resolveHermesc();
    if (hermesc === null) return;

    const bundle = await compileClientBundle();
    const stamp = `${process.pid}-${Date.now()}`;
    const sourcePath = path.join(os.tmpdir(), `plexus-activity-client-${stamp}.js`);
    const bytecodePath = path.join(os.tmpdir(), `plexus-activity-client-${stamp}.hbc`);

    try {
      writeFileSync(sourcePath, bundle, "utf8");
      execFileSync(hermesc, ["-w", "-emit-binary", "-out", bytecodePath, sourcePath]);
      expect(existsSync(bytecodePath)).toBe(true);
    } finally {
      rmSync(sourcePath, { force: true });
      rmSync(bytecodePath, { force: true });
    }
  });
});

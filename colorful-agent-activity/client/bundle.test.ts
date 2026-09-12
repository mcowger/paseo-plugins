import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(__dirname, "../index.client.tsx");

const PLUGIN_SDK_SPECIFIERS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
];

function resolveHermesc(): string | null {
  const platform = os.platform();
  const arch = os.arch();
  const sdkDir = path.resolve(__dirname, "../node_modules/react-native/sdks/hermesc");

  let binaryPath: string;
  if (platform === "linux" && arch === "x64") {
    binaryPath = path.join(sdkDir, "linux64-bin/hermesc");
  } else if (platform === "darwin") {
    binaryPath = path.join(sdkDir, "osx-bin/hermesc");
  } else if (platform === "win32" && arch === "x64") {
    binaryPath = path.join(sdkDir, "win64-bin/hermesc.exe");
  } else {
    return null;
  }

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
  it("bundles index.client.tsx and stays within mobile size budget", async () => {
    const bundle = await compileClientBundle();
    const sizeKb = Math.round(bundle.length / 1024);

    // Keep client bundle under 350 KB for mobile Hermes eval performance
    expect(sizeKb).toBeLessThan(350);
  });

  it("contains no ES6 classes in client bundle code", async () => {
    const bundle = await compileClientBundle();
    const codeWithoutComments = stripComments(bundle);

    // Hermes runtime eval fails on unlowered class expressions and declarations
    const classMatches: string[] = [];
    const lines = codeWithoutComments.split("\n");
    for (const [idx, line] of lines.entries()) {
      if (/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/.test(line)) {
        classMatches.push(`Line ${idx + 1}: ${line.trim()}`);
      }
    }

    expect(classMatches).toEqual([]);
  });

  it("compiles cleanly to Hermes bytecode via hermesc", async () => {
    const hermesc = resolveHermesc();
    if (!hermesc) {
      // Skip if hermesc prebuilt isn't available for the current host OS/architecture
      return;
    }

    const bundle = await compileClientBundle();
    const tmpJs = path.join(os.tmpdir(), `test-client-${Date.now()}.js`);
    const tmpHbc = path.join(os.tmpdir(), `test-client-${Date.now()}.hbc`);

    try {
      writeFileSync(tmpJs, bundle, "utf8");
      execFileSync(hermesc, ["-w", "-emit-binary", "-out", tmpHbc, tmpJs]);
      expect(existsSync(tmpHbc)).toBe(true);
    } finally {
      rmSync(tmpJs, { force: true });
      rmSync(tmpHbc, { force: true });
    }
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(directory, "../index.client.tsx");
const MAX_BUNDLE_SIZE_KB = 300;

function hermescPath(): string | null {
  const platform = os.platform();
  const arch = os.arch();
  const sdkDirectory = path.resolve(directory, "../node_modules/react-native/sdks/hermesc");
  const binary = platform === "linux" && arch === "x64"
    ? "linux64-bin/hermesc"
    : platform === "darwin"
      ? "osx-bin/hermesc"
      : platform === "win32" && arch === "x64"
        ? "win64-bin/hermesc.exe"
        : null;
  return binary && existsSync(path.join(sdkDirectory, binary)) ? path.join(sdkDirectory, binary) : null;
}

async function bundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    supported: { "async-await": false },
    external: ["@getpaseo/*", "react", "react/jsx-runtime", "react-native", "zod"],
    logLevel: "silent",
    write: false,
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error("Client bundle compilation produced no output");
  return output.replaceAll("get: () => from[key]", "value: from[key]");
}

describe("client mobile bundle compatibility", () => {
  it("keeps the client bundle small and free of ES6 classes", async () => {
    const output = await bundle();
    expect(output.length / 1024).toBeLessThan(MAX_BUNDLE_SIZE_KB);
    expect(output.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/);
  });

  it("compiles with Hermes", async () => {
    const hermesc = hermescPath();
    if (!hermesc) return;
    const sourcePath = path.join(os.tmpdir(), `pi-runtime-settings-${Date.now()}.js`);
    const bytecodePath = `${sourcePath}.hbc`;
    try {
      writeFileSync(sourcePath, await bundle());
      execFileSync(hermesc, ["-w", "-emit-binary", "-out", bytecodePath, sourcePath]);
      expect(existsSync(bytecodePath)).toBe(true);
    } finally {
      rmSync(sourcePath, { force: true });
      rmSync(bytecodePath, { force: true });
    }
  });
});

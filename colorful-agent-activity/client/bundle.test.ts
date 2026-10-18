import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import {
  assertNoClasses,
  buildClientPayload,
  findClientPayloadDrift,
} from "../scripts/build-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/** Compiles the catalog entry (the loader) the way the daemon does. */
async function compileLoaderBundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, "../index.client.tsx")],
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
  if (!output) throw new Error("Loader compilation produced empty output");
  return wrapCommonJsBundle(makeHermesInteropEager(output));
}

function findClassMatch(code: string): string | null {
  const stripped = stripComments(code);
  const match = stripped.match(/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/);
  return match ? match[0] : null;
}

/** Writes `code` to a temp file and compiles it to Hermes bytecode. */
function compileToBytecode(code: string): void {
  const hermesc = resolveHermesc();
  if (!hermesc) return; // No prebuilt compiler for this host OS/arch.
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmpJs = path.join(os.tmpdir(), `colorful-${stamp}.js`);
  const tmpHbc = path.join(os.tmpdir(), `colorful-${stamp}.hbc`);
  try {
    writeFileSync(tmpJs, code, "utf8");
    execFileSync(hermesc, ["-w", "-emit-binary", "-out", tmpHbc, tmpJs]);
    expect(existsSync(tmpHbc)).toBe(true);
  } finally {
    rmSync(tmpJs, { force: true });
    rmSync(tmpHbc, { force: true });
  }
}

describe("catalog loader (what Paseo ships and re-sends)", () => {
  it("stays tiny, because it is transferred on every connect", async () => {
    const bundle = await compileLoaderBundle();
    const sizeKb = Math.round(bundle.length / 1024);
    // ~4 KB today: the RPC contract, zod's string schema, and the loader.
    expect(sizeKb).toBeLessThan(16);
  });

  it("contains no ES6 classes", async () => {
    const bundle = await compileLoaderBundle();
    expect(findClassMatch(bundle)).toBeNull();
  });

  it("compiles cleanly to Hermes bytecode", async () => {
    compileToBytecode(await compileLoaderBundle());
  });
});

describe("client payload (fetched once, then cached)", () => {
  it("stays within the mobile budget after minification", async () => {
    const { code } = await buildClientPayload();
    const sizeKb = Math.round(code.length / 1024);
    // ~232 KB: the whole UI with every Prism grammar, minified.
    expect(sizeKb).toBeLessThan(320);
  });

  it("contains no ES6 classes, which Hermes eval cannot lower", async () => {
    const { code } = await buildClientPayload();
    expect(findClassMatch(code)).toBeNull();
    expect(() => assertNoClasses(code)).not.toThrow();
  });

  it("compiles cleanly to Hermes bytecode", async () => {
    const { code } = await buildClientPayload();
    compileToBytecode(code);
  });

  it("has generated modules that match a fresh build", async () => {
    // A stale payload is the one failure mode this design adds: the loader would
    // ship a version that no longer matches the code. `npm run build:client` fixes it.
    const { drift, version } = await findClientPayloadDrift();
    expect(drift, `Run \`npm run build:client\` (expected version ${version})`).toEqual([]);
  });
});

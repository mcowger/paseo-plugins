// Checks the compiled client bundle against the constraints Paseo clients
// impose: esbuild options mirror the app compiler, and the output must parse
// in Hermes (the mobile app's JS engine). Hermes VMs reject anonymous class
// expressions (`var X = class {`), which is exactly what esbuild emits for
// `class` in bundle mode, so client code must avoid classes entirely.
//
// Usage: node scripts/check-client-bundle.mjs
// Checks the bundled React Native Hermes compiler when available; a Hermes VM
// on PATH (or HERMES_BIN) also runs a syntax check.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = await build({
  entryPoints: [path.join(root, "index.client.tsx")],
  absWorkingDir: root,
  bundle: true,
  format: "cjs",
  jsx: "automatic",
  platform: "neutral",
  target: "es2020",
  mainFields: ["module", "main"],
  supported: { "async-await": false },
  external: [
    "@getpaseo/plugin",
    "@getpaseo/plugin/client",
    "@getpaseo/plugin/client/ui",
    "@getpaseo/plugin/client/react-native",
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

let output = result.outputFiles[0].text;
output = output.replaceAll("get: () => from[key]", "value: from[key]");
const bundle = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${output}\nreturn module.exports;\n})`;

const problems = [];
const patterns = [
  [/=\s*class\s*\{/, "anonymous class expression (Hermes: 'Invalid expression encountered'); use closure factories in client/"],
  [/\bimport\s*\(/, "dynamic import() (unsupported by Hermes)"],
  [/import\.meta/, "import.meta (unsupported by Hermes)"],
  [/\(\?<[=!]/, "regex lookbehind (unsupported by older Hermes)"],
  [/\bstatic\s*\{/, "static class block (unsupported by older Hermes)"],
];
for (const [pattern, message] of patterns) {
  const match = bundle.match(pattern);
  if (match) {
    const line = bundle.slice(0, match.index).split("\n").length;
    problems.push(`line ${line}: ${message}`);
  }
}

let hermesNote = "skipped (no hermes binary; set HERMES_BIN to run it)";
const isHermesVm = (candidate) => {
  try {
    const out = execFileSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Real VM banner: "Hermes JavaScript compiler and Virtual Machine".
    return /Virtual Machine/i.test(out);
  } catch {
    return false;
  }
};
const hermesBin = process.env.HERMES_BIN ?? process.env.PATH?.split(path.delimiter)
  .map((dir) => path.join(dir, "hermes"))
  .find(isHermesVm);
if (hermesBin) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "turn-speed-")), "client.bundle.js");
  writeFileSync(file, bundle);
  try {
    execFileSync(hermesBin, ["-w", file], { stdio: "pipe" });
    hermesNote = `PASSED (${hermesBin})`;
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split("\n").slice(0, 3).join(" ");
    problems.push(`hermes VM parse: ${detail}`);
    hermesNote = `FAILED (${hermesBin})`;
  }
}

const hermescPlatform = platform() === "linux" && arch() === "x64" ? "linux64-bin/hermesc"
  : platform() === "darwin" ? "osx-bin/hermesc"
  : platform() === "win32" && arch() === "x64" ? "win64-bin/hermesc.exe"
  : null;
const hermesc = hermescPlatform && path.join(root, "node_modules/react-native/sdks/hermesc", hermescPlatform);
if (hermesc && existsSync(hermesc)) {
  const dir = mkdtempSync(path.join(tmpdir(), "turn-speed-hermesc-"));
  const source = path.join(dir, "client.js");
  const bytecode = path.join(dir, "client.hbc");
  try {
    writeFileSync(source, bundle);
    execFileSync(hermesc, ["-w", "-emit-binary", "-out", bytecode, source], { stdio: "pipe" });
    hermesNote = `bytecode PASSED (${hermesc})`;
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split("\n").slice(0, 3).join(" ");
    problems.push(`hermes bytecode: ${detail}`);
    hermesNote = `bytecode FAILED (${hermesc})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (problems.length > 0) {
  console.error("client bundle check FAILED:");
  for (const problem of problems) console.error(" -", problem);
  process.exit(1);
}
console.log(`client bundle check OK (${bundle.split("\n").length} lines; hermes: ${hermesNote})`);

import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDirectory = fileURLToPath(new URL("../", import.meta.url));
async function bundle() {
  const result = await build({
    entryPoints: [path.join(pluginDirectory, "index.client.tsx")],
    bundle: true, format: "cjs", jsx: "automatic", platform: "neutral", target: "es2020",
    supported: { "async-await": false },
    external: ["@getpaseo/*", "react", "react/jsx-runtime", "react-native", "@tanstack/react-query", "zod"],
    write: false, metafile: true, logLevel: "silent",
  });
  const code = result.outputFiles[0]!.text.replaceAll("get: () => from[key]", "value: from[key]");
  return { code: `(function(require) { const module = {exports:{}}; const exports = module.exports;\n${code}\nreturn module.exports; })`, inputs: Object.keys(result.metafile.inputs) };
}

describe("native client bundle", () => {
  it("stays small and has no server or unlowered class code", async () => {
    const { code, inputs } = await bundle();
    expect(Buffer.byteLength(code)).toBeLessThan(300 * 1024);
    expect(inputs.some((input) => /[\\/]server[\\/]|superpi-companion/.test(input))).toBe(false);
    expect(code).not.toMatch(/require\(["']node:/);
    const stripped = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/);
  });

  it("compiles with the installed Hermes bytecode compiler", async () => {
    const platform = os.platform() === "darwin" ? "osx-bin" : os.platform() === "win32" ? "win64-bin" : "linux64-bin";
    const executable = os.platform() === "win32" ? "hermesc.exe" : "hermesc";
    const hermesc = path.join(pluginDirectory, "node_modules/react-native/sdks/hermesc", platform, executable);
    await fs.access(hermesc);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "superpi-hermes-"));
    try {
      const source = path.join(directory, "client.js");
      const output = path.join(directory, "client.hbc");
      await fs.writeFile(source, (await bundle()).code);
      execFileSync(hermesc, ["-w", "-emit-binary", "-out", output, source]);
      expect((await fs.stat(output)).size).toBeGreaterThan(0);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function compileClientBundle(entry = entryPath): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
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
    // Details/highlighting/settings must never drift back into the eager timeline bundle.
    // 0.8.0: 360 → 368 KiB for what every collapsed summary shows (the change stat with its uncounted changes, the turn's
    // tokens and their store) and exact-only diff counts on rows; the running animations and the expanded change list
    // wait in the fx chunk. 0.9.0: 368 → 372 KiB for the code font setting every row reads (shared/typography.ts).
    // 0.11.0: 372 → 373 KiB for the strength setting reaching the fold rows (the quiet predicate, hover state and the
    // strength read) and the settings screen's own ScrollView. 373 → 374 KiB for the failures expansion mode (the
    // resolver branch, the failed flag at the call sites) and the wrap-diff/command-colors settings reads; the command
    // coloring itself lives in the fx chunk, not here. 374 → 375 KiB for the thought tail-follow window (the schema
    // scalars and the windowed render in ReasoningText). 380 → 384 KiB for the optional timestamps (measured on the
    // merge with 0.11.0: 388 293 → 392 639 bytes): the turn-end renderer (client/turn-time.tsx) with its payload schema
    // and formatter (shared/turn-time.ts), about 2.5 KiB, and the foldTime reads and stamp slots of the rows, the fold
    // summary and the settings schema, about 1.7 KiB.
    // Provider-subagent event retention and inline status add approximately 10 KiB.
    expect(Buffer.byteLength(bundle)).toBeLessThanOrEqual(396 * 1024);
    expect(bundle).toContain("function ChangeStat");
    expect(bundle).toContain("function TurnTokens");
    expect(bundle).not.toMatch(/function (?:RunningLoader|LoaderFrame|FoldChanges|sparkleStops|shiftStops)\b/);
    expect(bundle).not.toMatch(/\/\/ .*\/client\/(?:activity-details|highlight|settings)\.tsx?\n/);
    expect(bundle).not.toContain("prismjs/components/");
    expect(bundle).toMatch(/(?:var|function) transformToolCall\b/);
    expect(bundle).toContain("function ColorfulToolCall");
    // 0.6.0-local.5: the Pi notice reader comes in its own chunk; the resident timeline keeps only isPiNotice/piNoticeStatus.
    expect(bundle).not.toMatch(/function (?:readPiNotice|subagentNotification|backgroundTask)\b/);
  });

  it("ships the Pi notice reader in a chunk of its own, without the fold or takeover state (0.6.0-local.5)", async () => {
    const bundle = await compileClientBundle(path.resolve(__dirname, "../pi-chunk.client.tsx"));
    expect(bundle).toContain("function readPiNotice");
    expect(bundle).not.toMatch(/\b(?:createFoldRuntime|foldRuntime|startTakeover|ColorfulToolCall|DetailBody)\b/);
    expect(Buffer.byteLength(bundle)).toBeLessThanOrEqual(96 * 1024);
  });

  it("ships the running animations and the change list in a small chunk of their own (0.8.0)", async () => {
    const bundle = await compileClientBundle(path.resolve(__dirname, "../fx-chunk.client.tsx"));
    expect(bundle).toContain("function RunningLoader");
    expect(bundle).toContain("function FoldChanges");
    expect(bundle).toContain("function CommandTokens");
    expect(bundle).not.toMatch(/\b(?:createFoldRuntime|foldRuntime|startTakeover|ColorfulToolCall|DetailBody|ActivitySettings)\b/);
    // 0.8.0: 72 KiB for the animations and the change list. 0.11.0: 128 KiB — Command colors (client/command-tokens.tsx)
    // pulls in the shared highlight module (Prism core and the language grammars; the shell grammar itself is the small
    // local one in client/highlight.ts). The chunk still downloads only when one of its features is actually used
    // (client/fx.ts useFx(enabled)).
    expect(Buffer.byteLength(bundle)).toBeLessThanOrEqual(128 * 1024);
  });

  it("keeps the chunk independent of the eager fold and takeover state", async () => {
    const bundle = await compileClientBundle(path.resolve(__dirname, "../ui-chunk.client.tsx"));
    expect(bundle).toContain("function DetailBody");
    expect(bundle).toContain("function ActivitySettings");
    // 0.8.0: the settings preview borrows the resident's running mark; the loaders live only in the fx chunk.
    expect(bundle).toContain("function LoaderPreview");
    expect(bundle).not.toMatch(/function (?:RunningLoader|LoaderFrame|sparkleStops|shiftStops)\b/);
    expect(bundle).not.toMatch(/\b(?:createFoldRuntime|foldRuntime|startTakeover|createLatestRows)\b/);
    expect(bundle).not.toMatch(/\/\/ .*\/client\/(?:fold-runtime|takeover|latest-rows)\.tsx?\n/);
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
    // 0.4.1: a private directory of our own (mkdtemp, mode 0700) instead of guessable names in the shared temp directory.
    const dir = mkdtempSync(path.join(os.tmpdir(), "vivid-hermes-"));
    const tmpJs = path.join(dir, "client.js");
    const tmpHbc = path.join(dir, "client.hbc");

    try {
      writeFileSync(tmpJs, bundle, { encoding: "utf8", flag: "wx" });
      execFileSync(hermesc, ["-w", "-emit-binary", "-out", tmpHbc, tmpJs]);
      expect(existsSync(tmpHbc)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

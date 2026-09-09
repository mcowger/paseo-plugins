/**
 * Pre-bundle the pi SDK + MCP SDK into a single CJS file.
 *
 * Why: Paseo wraps plugin server bundles as CJS evaluated without
 * __filename/import.meta. pi's dist reads import.meta.url at module scope
 * (createRequire, source-runtime detection), which dies in that environment.
 * We bundle with an import.meta.url shim so the vendored output is plain CJS.
 */
import { build } from "esbuild";

// Native optional deps of pi are kept external and resolved lazily at runtime.
const EXTERNALS = ["@mariozechner/clipboard", "@silvia-odwyer/photon-node"];

// Paseo wraps+evaluates bundles as CJS with no import.meta. A textual rewrite
// (not define/banner, which would not survive Paseo's own re-bundle) removes
// import.meta.url reads inside vendored sources, and the output stays ESM so
// esbuild sees static named exports (CJS vendored output trips Paseo's eager
// interop rewrite).
const stripImportMeta = {
  name: "strip-import-meta",
  setup(b) {
    b.onLoad({ filter: /\.m?js$/ }, async (args) => {
      const { readFile } = await import("node:fs/promises");
      let contents = await readFile(args.path, "utf8");
      if (!contents.includes("import.meta.url")) return undefined;
      contents = contents.replaceAll(
        "import.meta.url",
        '(typeof process !== "undefined" && process.cwd ? "file://" + process.cwd() + "/pi-sdk-vendor.js" : "file:///unknown")',
      );
      return { contents, loader: "js" };
    });
  },
};

await build({
  entryPoints: ["server/vendor-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "server/vendor/pi-sdk.mjs",
  external: EXTERNALS,
  plugins: [stripImportMeta],
  logLevel: "warning",
});
console.log("wrote server/vendor/pi-sdk.mjs");

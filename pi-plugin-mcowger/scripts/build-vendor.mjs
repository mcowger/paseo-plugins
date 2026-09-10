/**
 * Pre-bundle the pi SDK + MCP SDK into a single ESM file for Paseo.
 *
 * Why: Paseo evaluates plugin server bundles as CJS via eval with an injected
 * require, then applies an eager interop rewrite that wrecks esbuild's CJS
 * re-export chains. Vendoring as ESM with static named exports sidesteps both.
 * No import.meta usage may survive: the runtime has none. pi's extension
 * loader roots jiti alias/require resolution at import.meta.url, so those
 * reads are rewritten to this plugin's installed pi copy, and pi's jiti alias
 * map (getAliases) is replaced with a curated runtime map because pi's
 * built-mode version leans on import.meta in ways that never survive bundling.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Native optional deps of pi are kept external and resolved lazily at runtime.
const EXTERNALS = ["@mariozechner/clipboard", "@silvia-odwyer/photon-node"];

const piAnchor = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  ),
).href;
console.log("pi anchor:", piAnchor);

// Replaces import.meta.resolve(...) inside vendored sources. Resolves package
// specifiers against the pi install's nested node_modules, honoring package
// exports (including wildcard subpath entries) with the ESM "import" condition.
const resolverSource = `(function (spec) {
  var path = require("node:path");
  var fs = require("node:fs");
  var url = require("node:url");
  var anchorDir = path.dirname(url.fileURLToPath(${JSON.stringify(piAnchor)}));
  var match = spec.match(/^(@[^/]+\\/[^/]+)(\\/.*)?$/) || spec.match(/^([^/]+)(\\/.*)?$/);
  if (!match) return spec;
  var pkgName = match[1];
  var subpath = match[2] || "";
  var root = path.normalize(path.join(anchorDir, "..", "node_modules", pkgName));
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    var key = subpath ? "." + subpath : ".";
    var exp = pkg.exports && (pkg.exports[key] ?? (!subpath ? pkg.exports["."] : undefined));
    var entry =
      (exp && (typeof exp === "string" ? exp : exp.import ?? exp.default)) ??
      (subpath ? null : (pkg.module ?? pkg.main ?? "index.js"));
    if (!entry && subpath && pkg.exports) {
      for (var pattern of Object.keys(pkg.exports)) {
        if (pattern.indexOf("*") < 0) continue;
        var keyRe = new RegExp("^" + pattern.replace(/[.+?^$\\{\\}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*/g, "(.*)") + "$");
        var keyMatch = keyRe.exec(key);
        if (!keyMatch) continue;
        var target = pkg.exports[pattern];
        var targetExp = typeof target === "string" ? target : target && (target.import ?? target.default);
        if (!targetExp) continue;
        entry = targetExp.replace(/\\*/g, keyMatch[1] ?? "");
        break;
      }
    }
    var file = entry ? path.join(root, entry) : path.join(root, subpath.replace(/^\\//, ""));
    if (fs.existsSync(file)) return url.pathToFileURL(file).href;
  } catch {}
  return spec;
})`;

// jiti aliases mirror pi's built-mode getAliases() map, but resolved from the
// anchor instead of import.meta. Values are plain fs paths, as jiti expects.
const aliasesSource = `(function () {
  var url = require("node:url");
  var anchorFile = url.fileURLToPath(${JSON.stringify(piAnchor)});
  var toPath = function (spec) {
    try {
      return url.fileURLToPath(PI_VENDOR_META_RESOLVE(spec));
    } catch {
      return undefined;
    }
  };
  var agent = anchorFile;
  var core = toPath("@earendil-works/pi-agent-core");
  var tui = toPath("@earendil-works/pi-tui");
  var compat = toPath("@earendil-works/pi-ai/compat");
  var oauth = toPath("@earendil-works/pi-ai/oauth");
  var providersAll = toPath("@earendil-works/pi-ai/providers/all");
  var typebox = toPath("typebox");
  var typeboxCompile = toPath("typebox/compile");
  var typeboxValue = toPath("typebox/value");
  return {
    "@earendil-works/pi-coding-agent": agent,
    "@earendil-works/pi-agent-core": core,
    "@earendil-works/pi-tui": tui,
    "@earendil-works/pi-ai": compat,
    "@earendil-works/pi-ai/compat": compat,
    "@earendil-works/pi-ai/oauth": oauth,
    "@earendil-works/pi-ai/providers/all": providersAll,
    "@mariozechner/pi-coding-agent": agent,
    "@mariozechner/pi-agent-core": core,
    "@mariozechner/pi-tui": tui,
    "@mariozechner/pi-ai": compat,
    "@mariozechner/pi-ai/compat": compat,
    "@mariozechner/pi-ai/oauth": oauth,
    "@mariozechner/pi-ai/providers/all": providersAll,
    typebox: typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
    "@sinclair/typebox": typebox,
    "@sinclair/typebox/compile": typeboxCompile,
    "@sinclair/typebox/value": typeboxValue,
  };
})()`;

const stripImportMeta = {
  name: "strip-import-meta",
  setup(b) {
    b.onLoad({ filter: /\.m?js$/ }, async (args) => {
      const { readFile } = await import("node:fs/promises");
      let contents = await readFile(args.path, "utf8");
      const touchedMeta =
        contents.includes("import.meta.url") || contents.includes("import.meta.resolve");
      const touchedAliases = args.path.includes("core/extensions/loader");
      if (!touchedMeta && !touchedAliases) return undefined;
      if (touchedMeta) {
        contents = contents.replaceAll("import.meta.url", JSON.stringify(piAnchor));
        contents = contents.replaceAll("import.meta.resolve(", "PI_VENDOR_META_RESOLVE(");
      }
      if (touchedAliases) {
        contents = contents.replaceAll("alias: getAliases()", "alias: PI_VENDOR_ALIASES");
      }
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
  // pi's dep tree contains CJS packages (cross-spawn etc.); esbuild's ESM
  // output shims require() with a throwing stub unless we inject a real one.
  banner: {
    js: `import { createRequire as __piVendorCreateRequire } from "node:module";\nvar require = __piVendorCreateRequire(${JSON.stringify(piAnchor)});\nvar PI_VENDOR_META_RESOLVE = ${resolverSource};\nvar PI_VENDOR_ALIASES = ${aliasesSource};`,
  },
});
console.log("wrote server/vendor/pi-sdk.mjs");

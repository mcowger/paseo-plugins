/**
 * Postinstall: sanitize unresolvable import() type atoms in dependency
 * declaration files (.d.ts / .d.mts) under node_modules.
 *
 * Vendor declaration files (Anthropic SDK, OpenAI SDK inside pi's dependency
 * tree) ship defensive unions like:
 *
 *   NotAny<import('node-fetch').RequestInit> | NotAny<import("../../../node_modules/undici/index.d.ts.mjs").RequestInit> | ...
 *
 * meant to tolerate missing optional peers. Paseo's plugin boundary checker
 * resolves every import-type expression and hard-fails on the ones that can't
 * resolve (relative node_modules probes, `.js`-suffixed pseudo-packages,
 * `@types/*` packages that aren't installed). Those atoms exist only as
 * "fall back to any" shims, so we rewrite each unresolvable one to `unknown`,
 * preserving the union's intent.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const DECLARATION_FILE = /\.d\.[cm]?ts$|\.d\.ts\.mjs$/;
const NOT_ANY_IMPORT = /NotAny<\s*import\(\s*(["'])([^"']+)\1\s*\)\s*(?:\.[A-Za-z0-9_$]+)?\s*>/g;

function isResolvable(specifier, fromFile) {
  if (specifier.startsWith(".")) {
    return false; // relative probes under node_modules never resolve legitimately here
  }
  if (/\.[cm]?js$/.test(specifier)) {
    return false; // pseudo-package like "node-fetch.js" / "node-fetch.mjs"
  }
  try {
    require.resolve(specifier, { paths: [dirname(fromFile)] });
    return true;
  } catch {
    return false;
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (DECLARATION_FILE.test(entry)) {
      yield full;
    }
  }
}

let patchedFiles = 0;
for (const file of walk(join(process.cwd(), "node_modules"))) {
  const content = readFileSync(file, "utf8");
  if (!content.includes("NotAny<")) {
    continue;
  }
  let touched = false;
  const fixed = content.replace(NOT_ANY_IMPORT, (whole, _quote, specifier) => {
    if (isResolvable(specifier, file)) {
      return whole;
    }
    touched = true;
    return "unknown";
  });
  if (touched) {
    writeFileSync(file, fixed, "utf8");
    patchedFiles += 1;
    console.log(`[postinstall] neutralized unresolvable type imports in ${file}`);
  }
}
if (patchedFiles === 0) {
  console.log("[postinstall] no declaration patches needed");
}

# Packaging notes: getting pi's SDK through Paseo's plugin compiler

This plugin embeds the pi coding agent SDK in-process. Getting that to build and run
inside Paseo's plugin runtime took three non-obvious tricks. All of them are in this
repo, and all of them exist because of the same root cause: Paseo compiles, wraps, and
evaluates plugin server code in a way that assumes small, well-behaved dependencies.
pi's SDK is neither.

If you are building another provider plugin on a heavy npm package, start here.

## How Paseo actually builds a plugin server entry

Two things matter, both living in `packages/server/src/server/plugins/compiler.ts` and
the surrounding plugin runtime:

1. **A boundary checker walks your imports, including type-only ones, with full
   TypeScript module resolution.** Every import specifier in every reachable file gets
   resolved. When resolution lands on a declaration file (`.d.ts`, `.d.mts`), that file
   is read and its own imports are walked too, recursively, through your entire
   `node_modules` tree. A single unresolvable type import fails the build. There is no
   "skipLibCheck for bundling" escape hatch.

2. **The server bundle is emitted as CJS, wrapped in a function, and evaluated with
   `globalThis.eval` and an injected `require`.** There is no `import.meta`, no
   `__filename`, no ESM anything at plugin evaluation time. On top of that, every bundle
   is run through `makeHermesInteropEager`, which rewrites esbuild's lazy CJS interop
   getters (`get: () => from[key]`) into eager values (`value: from[key]`). That rewrite
   is meant for Hermes client bundles; on the server side it breaks module init order
   for CJS re-export chains, and named exports arrive as `undefined`.

## Trick 1: never `import type` from pi's packages

Any `import type { X } from "@earendil-works/pi-coding-agent"` pulls pi's entire
declaration graph into the boundary checker. pi's graph reaches the Anthropic and OpenAI
SDKs, whose shipped `.d.mts` files are full of defensive unions written for their own
monorepo tooling:

```ts
type UndiciRequestInit =
  | NotAny<import("undici").RequestInit>
  | NotAny<import("../../../node_modules/undici-types/index.d.ts.mjs").RequestInit>
  | NotAny<import("@types/node-fetch").RequestInit>
  | NotAny<import("../../../../node_modules/node-fetch.mjs").RequestInit>
  | ...
```

Those relative paths exist nowhere. Each `import(...)` type expression counts as a
specifier the checker must resolve, and one failure kills the build. There are hundreds
of them across `anthropic`, `openai`, and `genai` declaration files.

The fix has two parts.

First, pi source is never type-imported from compiled code. Every type this plugin
needs is declared locally in `shared/pi-sdk-types.ts` as structural subsets
(`PiAgentSessionLike`, `PiSessionManagerLike`, event unions, tool definition), reusing
the shapes the RPC mode serialized (the RPC protocol is the SDK's events with JSON
frames around them, so the types are already battle-tested). At the one place where a
real SDK object crosses in, we cast once to the structural type and never look back.

Second, the one compiled file that must declare types for the vendored runtime
(`server/vendor/pi-sdk.d.mts`) is hand-written and self-contained, importing only from
`shared/`. No third-party type can leak in.

Bonus from doing this: pi can restructure its internals between releases and the plugin
doesn't care, because it never statically names pi's real types.

## Trick 2: rewrite broken vendor type probes at install time

The previous trick doesn't help enough on its own, because value imports make
TypeScript resolve the package's declarations too, and the boundary checker follows
them. So `scripts/postinstall.mjs` sweeps `node_modules` declaration files and
rewrites each unresolvable defensive atom to `unknown`:

```ts
// before
type X = NotAny<import("undici").RequestInit>
       | NotAny<import("../../../node_modules/undici/index.d.ts.mjs").RequestInit>
       | NotAny<import("@types/node-fetch").RequestInit>;

// after
type X = NotAny<import("undici").RequestInit> | unknown | unknown;
```

Anything still resolvable (like bare `import("undici")`, which points at pi's real
nested copy) is left untouched. This is safe for what these unions are for: they exist
so users without optional peer packages still compile. `unknown` is what they
degenerate to anyway. The plugin's own `tsc --noEmit` never reads these files
(`skipLibCheck`), and the boundary checker's structural scan no longer trips.

Seven files get patched on this machine (anthropic ×2, openai ×2, genai ×3). Yours may
vary; the sweep is a plain recursive walk with a resolvability test, so it doesn't care.

`postinstall` in package.json runs it, because `node_modules` gets rebuilt.

## Trick 3: vendored ESM bundle with import.meta textually stripped

pi's dist reads `import.meta.url` at module top level (`createRequire(import.meta.url)`
and source-runtime detection). In Paseo's eval'd CJS wrapper that value is `undefined`
and the plugin dies at load with Node's "path argument must be of type string" error.

The first attempt was `scripts/build-vendor.mjs` emitting CJS plus an esbuild `define`
shim for `import.meta.url`. That works until Paseo re-bundles our bundle. Re-bundling
a CJS module makes esbuild generate the lazy interop getters that
`makeHermesInteropEager` eagerly breaks, and your exports show up as `undefined`
(`typeof ModelRuntime === "undefined"` at runtime, found by reproducing the daemon's
exact compile-and-eval path locally and running a catalog request through it).

Current approach, which holds up end to end:

- `scripts/build-vendor.mjs` bundles pi + the MCP SDK to one file with esbuild,
  `format: "esm"`. ESM output has static named exports, so when Paseo later inlines it,
  esbuild doesn't need CJS interop helpers at all and the eager rewrite has nothing to
  damage.
- An onLoad plugin textually replaces every `import.meta.url` in imported sources with
  a plain `file://` URL string derived from `process.cwd()`. Textual, because esbuild
  `define` shims and banners do not survive being bundled a second time. The vendored
  file contains the string `import.meta.url` zero times.
- pi's optional native deps (`@mariozechner/clipboard`, `@silvia-odwyer/photon-node`)
  are marked external so esbuild leaves their lazy runtime requires alone.
- Type sidecar: `server/vendor/pi-sdk.d.mts`, hand-written (see trick 1).

The build runs from `postinstall`, and `npm run build:vendor` redoes it after
dependency changes.

## How to verify a packaging change without bouncing the daemon

The daemon's exact semantics are reproducible in a Node one-liner. It saved three
round trips at least:

```js
import { compilePlugin } from "~/workspace/paseo/packages/server/dist/server/server/plugins/compiler.js";
const { serverBundle } = await compilePlugin({ client: null, server: "./index.server.ts" });
const factory = globalThis.eval(serverBundle);
const exportsObj = factory((name) =>
  name.startsWith("@getpaseo/") ? hostStubFor(name) : require(name)
);
let registration;
exportsObj.default({ registerProvider: (r) => (registration = r), handle: () => () => {}, registerSettings: () => () => {}, on: () => () => {}, before: () => () => {} });
const conn = await registration.connect({ versions: [1], capabilities: [...] });
conn.onEvent(console.log);
await conn.send({ type: "catalog", requestId: "r1", cwd: process.cwd() });
```

The `hostStubFor` bit is whatever your bundle's top level touches; for this plugin only
`@getpaseo/plugin/server/provider` needs real functions (import the built
`@getpaseo/plugin` dist, it's right there in the paseo checkout).

## Bonus chapter: jiti, user extensions, and the alias map

pi loads user extensions (~/.pi/agent/extensions, plus npm packages from
settings.json `packages`) through jiti. In built mode jiti gets its module
resolution anchored at `import.meta.url` and an alias table from `getAliases()`
(mapping `@earendil-works/pi-*`, typebox, etc. to pi's install). Neither survives
vendoring: with the meta URL stripped, aliases resolve through nested-node_modules
guessing and user extensions fail one after another with `Invalid URL`.

`build-vendor.mjs` therefore also replaces `import.meta.resolve(` calls with a
banner-injected resolver (`PI_VENDOR_META_RESOLVE`) that honors package `exports`
(including wildcard subpaths like `./providers/*`) against the plugin's installed
pi copy, and rewrites the loader's `{ alias: getAliases() }` call to a curated
runtime map (`PI_VENDOR_ALIASES`) with the same entries pi uses, computed at
bundle-evaluation time.

Verify extension loading works before shipping with a one-liner against the
vendored bundle: create a `DefaultResourceLoader`, `reload()`, and print
`getExtensions().errors` — expect zero.

## Daemon-side notes worth fixing upstream eventually

None of these block this plugin, but each cost an evening:

- The boundary checker hard-fails on unresolvable imports inside third-party
  declaration files. Plugin authors cannot control Anthropic's declaration output. It
  should warn and skip when the importer is under `node_modules`.
- `makeHermesInteropEager` runs on server bundles, not just the Hermes client bundles
  it was written for. ESM-re-export-heavy server bundles can silently lose exports.
- A provider emitting `request.failed` for certain requests crashes the whole daemon
  through an unhandled rejection in the provider bridge (`failRequest`). A broken
  plugin should break itself, not the daemon.
- Provider `session.open` without a `cwd`, and refresh of agents whose provider runtime
  just got recycled by a plugin reload, both leak confusing errors to the UI.

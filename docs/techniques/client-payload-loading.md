# Ship a tiny loader, fetch the real client bundle once

How `colorful-agent-activity` cuts its cost per reconnect from ~548 KB of client code to ~3 KB, by
moving the real bundle behind an RPC and caching it in the app's JS context under a build-time hash.

The excerpts below are from that plugin, trimmed but otherwise verbatim.

## The problem

Paseo compiles `index.client.tsx` on the daemon and ships the output inside the plugin catalog. It
re-sends that catalog on every connect and every plugin change, and it does not minify.

So a plugin with real UI pays full price for its own size on every reconnect. On a laptop that is
nothing. On mobile over a flaky link it is the difference between the timeline appearing and a stall.

There is no config knob for this. The fix is to change what the catalog entry contains.

## The shape

Split one entry into two:

- `index.client.tsx` is a loader. It ships in the catalog and stays tiny.
- `client/entry.tsx` is the real entry. The build script compiles it ahead of time into a minified
  payload, and the plugin's own server serves that payload over RPC.

| Piece | File | Role |
| --- | --- | --- |
| Catalog entry | `index.client.tsx` | Checks the cache, maybe fetches, evaluates the payload, returns cleanup |
| Real entry | `client/entry.tsx` | Everything the plugin contributes |
| Build | `scripts/build-client.ts` | Compiles and minifies the payload, stamps its hash |
| Contract | `shared/client-payload.ts` | The `client.payload` RPC, Zod validated |
| Server | `server/payload.ts` | Answers the RPC from a generated string constant |
| Version | `shared/client-payload-version.ts` | The payload hash the loader was built against |

Current sizes for this plugin:

```
catalog entry (loader)   3.1 KB
payload, minified      260.8 KB
payload, unminified    548.2 KB   <- what Paseo would ship without this
```

Splitting without minifying buys you nothing, by the way. Both halves matter.

## The cache key is a content hash, stamped at build time

No TTL, no manual cache busting, no invalidation endpoint. The payload's hash becomes the version,
and the version gets compiled into the loader:

```ts
// scripts/build-client.ts
export function payloadVersion(code: string): string {
  return hash("sha256", code, "hex").slice(0, 12);
}
```

```ts
// shared/client-payload-version.ts (generated)
export const CLIENT_PAYLOAD_VERSION = "c18066b30bb0";
```

Change any input to the bundle and the hash changes. The loader is recompiled with the new stamp, so
the catalog entry changes, and that is the thing Paseo already notices and acts on. A warm cache that
does not match the stamp is treated as cold.

The cache lives on `globalThis`, which is the host app's global and therefore shared with every other
plugin. Prefix the key with your plugin id or you will eventually collide with someone:

```ts
// index.client.tsx
const CACHE_KEY = "__colorfulActivityClientPayload";

const cacheStore = globalThis as typeof globalThis & {
  [CACHE_KEY]?: PayloadCache;
};
```

## The loader

This is the whole contribution path:

```ts
// index.client.tsx
export default function contribute(client: PluginClientContext): () => void {
  let dispose: (() => void) | null = null;
  let cancelled = false;

  const start = (code: string) => {
    if (cancelled) return;
    try {
      dispose = runPayload(code, client);
    } catch (error) {
      console.warn("[colorful-agent-activity] Couldn't start the client payload", error);
    }
  };

  const cached = cacheStore[CACHE_KEY];
  if (cached && cached.version === CLIENT_PAYLOAD_VERSION) {
    start(cached.code);
  } else {
    void client
      .rpc(clientPayloadRpc, {})
      .then((payload) => {
        if (cancelled) return;
        if (payload.version === CLIENT_PAYLOAD_VERSION) {
          cacheStore[CACHE_KEY] = { version: payload.version, code: payload.code };
        }
        start(payload.code);
      })
      .catch((error: unknown) => {
        console.warn("[colorful-agent-activity] Couldn't load the client payload", error);
      });
  }

  return () => {
    cancelled = true;
    const teardown = dispose;
    dispose = null;
    try {
      teardown?.();
    } catch (error) {
      console.warn("[colorful-agent-activity] Client payload cleanup failed", error);
    }
  };
}
```

Four things are load-bearing here.

**The warm path is synchronous.** On a reconnect with a warm cache, `contribute` registers the
plugin's surfaces, timeline transformers, and command items on the same tick, exactly like a normal
entry. If registration were always async you would see the UI pop in a frame late every single
reconnect, which is worse than the bytes you saved. Only the first load in a session pays that.

**`cancelled` outlives the fetch.** Paseo can install, remove, or re-evaluate the plugin before the
RPC resolves. Without the flag, a late payload registers contributions into a context that is
already gone.

**The version check guards caching, not execution.** If the daemon hands back a payload whose version
does not match the loader's stamp, the loader runs it but does not cache it. That is the mid-reload
race: a stale copy on disk is worse than no copy.

**Nothing throws.** A failed fetch or a payload that will not evaluate logs a warning and leaves the
plugin unregistered. Paseo's install path catches evaluation errors too, but a warning plus a dead
plugin beats a blank surface with no explanation.

## Running the code: reuse the host's own wrapper

Paseo wraps every client bundle as `(function(require) { ... })` and calls it with its own module
resolver. The build script wraps the payload the same way, so evaluating it returns a factory that
takes `require`:

```ts
// index.client.tsx
// Paseo wraps every client bundle as `(function(require) { … })` and calls it
// with its own module resolver, so this identifier is the host resolver inside
// this module too. The payload needs it to reach the host modules.
declare const require: (name: string) => unknown;

type PayloadFactory = (require: unknown) => { default?: unknown };

const evaluate = globalThis.eval;

function runPayload(code: string, client: PluginClientContext): () => void {
  const factory = evaluate(code) as unknown;
  if (typeof factory !== "function") {
    throw new Error("Colorful Activity client payload is not executable");
  }
  const exports = (factory as PayloadFactory)(require);
  const setup = exports && typeof exports === "object" ? exports.default : undefined;
  if (typeof setup !== "function") {
    throw new Error("Colorful Activity client payload has no default export");
  }
  const cleanup = (setup as (context: PluginClientContext) => unknown)(client);
  return typeof cleanup === "function" ? (cleanup as () => void) : () => {};
}
```

Passing the loader's own `require` is the part that makes this work. Every host module
(`@getpaseo/plugin/client`, `react`, `react-native`, `zod`) resolves through Paseo's resolver, so the
payload shares the host's instances. No second copy of React, no second copy of the query client, no
hook-order disaster.

`await import()` would not do this. The payload has to get the host resolver explicitly, and the
wrapper is the only supported way to hand it over.

## Serving the payload from the server bundle

The payload is a string constant in the server bundle, not a file on disk:

```ts
// server/payload.ts
export function registerClientPayload(server: PluginServerContext): void {
  server.handle(clientPayloadRpc, () => ({
    version: CLIENT_PAYLOAD_VERSION,
    code: CLIENT_PAYLOAD,
  }));
}
```

Reading it from disk would not work. A plugin server module is evaluated from a string, so it has no
reliable `__dirname`, and an install can live at any path. Embedding the code in the module sidesteps
both problems, at the cost of a large generated TypeScript file (~260 KB of escaped string) that you
commit.

The contract is ordinary Paseo RPC, so validate both ends:

```ts
// shared/client-payload.ts
export const clientPayloadRpc = defineRpc({
  name: "client.payload",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    code: z.string(),
  }),
});
```

## The build script

It mirrors Paseo's compile options and then minifies. The mirroring is not optional: a mismatch shows
up as a Hermes evaluation failure on a device, not as a build error. Compare against `compileTarget`
in Paseo's `packages/server/src/server/plugins/compiler.ts`, and copy the `loader` map too if you
import non-JS assets (Paseo maps `.svg` to `text`).

The one deliberate difference is `minify`. Paseo does not set it, so the catalog carries unminified
code. That is most of why this technique is worth the trouble.

```ts
// scripts/build-client.ts
export async function buildClientPayload(): Promise<ClientPayloadBuild> {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["client/entry.tsx"],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    supported: { "async-await": false },
    mainFields: ["module", "main"],
    external: EXTERNALS,
    minify: true,
    legalComments: "none",
    treeShaking: true,
    logLevel: "silent",
    metafile: true,
    write: false,
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error("Client payload compilation produced no output");
  return {
    code: wrapCommonJsBundle(makeHermesInteropEager(output)),
    inputs: Object.keys(result.metafile.inputs),
  };
}
```

Two transformations come off Paseo's own compiler and both are easy to miss.

`wrapCommonJsBundle` is the `(function(require) { ... })` wrapper described above.

`makeHermesInteropEager` is the one that bites:

```ts
/** Mirrors Paseo's `makeHermesInteropEager`: Hermes resolves esbuild's lazy getters to the last export. */
function makeHermesInteropEager(code: string): string {
  return code.replaceAll("get: () => from[key]", "value: from[key]");
}
```

esbuild emits CJS interop getters to keep tree-shaking honest. Hermes, evaluating a bundle from a
string, resolves those getters to the wrong export. Paseo rewrites them, so the prebuilt payload has
to rewrite them too, or it fails only on mobile.

`EXTERNALS` has to list every host-provided module. Miss one and it gets inlined instead of resolved,
which is how you end up with two copies of `zod` and a schema identity check that never matches.

## Guards

Five checks guard the output, because every failure mode here is invisible until a device tries it.
Two run in the build script.

The payload must not reach into `server/`. `platform: "neutral"` already fails on Node built-ins, but
not on your own server modules, and the daemon's boundary plugin is not in this path:

```ts
export function assertClientBoundary(inputs: readonly string[]): void {
  const offenders = inputs.filter((input) => input.replaceAll("\\", "/").startsWith("server/"));
  if (offenders.length > 0) {
    throw new Error(`Client payload imports server-only modules: ${offenders.join(", ")}`);
  }
}
```

No ES6 classes. Hermes under `eval()` has known failures with class expressions assigned to
variables, and you find out in the field:

```ts
export function assertNoClasses(code: string): void {
  const stripped = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const match = stripped.match(/\bclass\s+[A-Za-z0-9_$]+|\bclass\s*\{|=\s*class\b/);
  if (match) throw new Error(`Client payload contains an ES6 class: ${match[0]}`);
}
```

The test suite adds the other three: a size budget, a real `hermesc -emit-binary` compile of both
the loader and the payload, and the drift check below. `hermesc` catches syntax the V8-based test
runner happily accepts.

The drift check is the one you will actually hit in day to day work:

```ts
export async function findClientPayloadDrift(): Promise<{ version: string; drift: string[] }> {
  const { code } = await buildClientPayload();
  const version = payloadVersion(code);
  const drift: string[] = [];
  for (const [file, render] of GENERATED) {
    const expected = render(version, code);
    const actual = await readFile(path.join(root, file), "utf8").catch(() => "");
    if (actual !== expected) drift.push(file);
  }
  return { version, drift };
}
```

```ts
it("has generated modules that match a fresh build", async () => {
  const { drift, version } = await findClientPayloadDrift();
  expect(drift, `Run \`npm run build:client\` (expected version ${version})`).toEqual([]);
});
```

The generated files have to be committed. Paseo installs npm and git sources with
`--ignore-scripts --omit=dev`, so nothing will run the build on the user's machine, and a
`paseo-plugin.json` build command cannot assume your dev dependencies are present. Committed output
plus a failing test is the only configuration that stays honest.

## What it costs

- First load in a session costs one RPC round trip before any contribution exists. Warm reconnects
  cost nothing.
- One new failure mode: a stale payload whose version no longer matches its code. The drift test is
  the whole mitigation, and it fails loudly with the command to run.
- Two generated files in the tree that you never edit by hand.
- A compile option you have to keep in step with Paseo's `compiler.ts` across host upgrades. Treat
  that as a checklist item when bumping the SDK baseline.

## When it is worth it

Do it when the catalog entry is big enough to notice, which for a plugin with a real UI means a few
hundred KB, or when your users are on mobile links that reconnect often.

Skip it for a 20 KB plugin. You would add a build step, two generated files, a cold-start RPC, and a
class of drift bugs to save a number nobody notices.

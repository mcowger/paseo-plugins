import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CLIENT_PAYLOAD_VERSION, clientPayloadRpc } from "./shared/client-payload";

/**
 * The client entry Paseo compiles and ships inside the plugin catalog.
 *
 * Paseo re-sends every plugin's entire client bundle on each connect and each
 * plugin change, which is expensive on an unreliable link. So the catalog entry
 * is this loader (~1 KB) and the real client code travels once over an RPC,
 * cached in the app's JS context under the payload's hash:
 *
 * - warm cache (the usual reconnect): no request at all, registration is
 *   synchronous, exactly like a normal plugin entry;
 * - cold cache (first load in a session): one RPC, then registration.
 *
 * `server/payload.ts` serves the code; `scripts/build-client.mjs` builds it and
 * stamps both the payload and this loader's version.
 */

interface PayloadCache {
  version: string;
  code: string;
}

const CACHE_KEY = "__colorfulActivityClientPayload";

// Paseo wraps every client bundle as `(function(require) { … })` and calls it
// with its own module resolver, so this identifier is the host resolver inside
// this module too. The payload needs it to reach the host modules.
declare const require: (name: string) => unknown;

const cacheStore = globalThis as typeof globalThis & {
  [CACHE_KEY]?: PayloadCache;
};

type PayloadFactory = (require: unknown) => { default?: unknown };

// The same mechanism Paseo uses to evaluate the bundle that contains this file.
// The payload is a factory that takes `require`, so it needs no scope from here.
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

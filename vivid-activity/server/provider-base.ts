import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 0.8.0: which built-in provider an Agent's provider is built on. Custom providers are named freely in the daemon config
 * (`agents.providers.<id>.extends`), so a turn's token figures are read the way their base reports them
 * (server/turn-usage.ts), never by guessing from the id. Only `extends` is kept from the config; nothing else leaves
 * this module. Built-in ids of Paseo 0.11.1 (`provider-registry.js`) map to themselves; `acp` is the generic base.
 */
export const BUILTIN_PROVIDERS: readonly string[] = ["claude", "codex", "opencode", "pi", "omp", "copilot", "cursor", "acp"];
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const PROVIDER_ID = /^[\w.-]{1,64}$/;
/** How long one read of the config is used. */
export const PROVIDER_BASE_TTL_MS = 60_000;

/** `PASEO_HOME` when absolute or `~/…`, else `~/.paseo`. */
export function daemonHome(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): string {
  const raw = env.PASEO_HOME?.trim();
  if (!raw) return join(home, ".paseo");
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : join(home, ".paseo");
}

/** Custom provider id → the provider it extends, from a parsed daemon config (one level, as Paseo allows). */
export function basesFromConfig(config: unknown): Map<string, string> {
  const bases = new Map<string, string>();
  const providers = (config as { agents?: { providers?: unknown } } | null)?.agents?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return bases;
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
    const base = entry && typeof entry === "object" ? (entry as { extends?: unknown }).extends : undefined;
    if (PROVIDER_ID.test(id) && typeof base === "string" && PROVIDER_ID.test(base)) bases.set(id, base);
  }
  return bases;
}

/** The daemon config's text, at most MAX_CONFIG_BYTES; null when missing, unreadable or larger. Never throws. */
export async function readDaemonConfig(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(join(daemonHome(env, home), "config.json"), "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
    const buffer = Buffer.alloc(Math.min(info.size, MAX_CONFIG_BYTES) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MAX_CONFIG_BYTES ? null : buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * `baseOf(providerId)`: the built-in an id is built on, or null when unknown. The config is read at most once per
 * PROVIDER_BASE_TTL_MS; a read that fails or does not parse counts as having no custom providers until then.
 */
export function createProviderBases(options: { read?: () => Promise<string | null>; now?: () => number; ttlMs?: number } = {}) {
  const read = options.read ?? (() => readDaemonConfig());
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? PROVIDER_BASE_TTL_MS;
  let cached: { at: number; bases: Map<string, string> } | null = null;
  let loading: Promise<Map<string, string>> | null = null;
  async function bases(): Promise<Map<string, string>> {
    if (cached && now() - cached.at < ttl) return cached.bases;
    if (!loading) {
      loading = read()
        .then((text) => {
          try {
            return text ? basesFromConfig(JSON.parse(text)) : new Map<string, string>();
          } catch {
            return new Map<string, string>();
          }
        })
        .catch(() => new Map<string, string>())
        .then((found) => {
          cached = { at: now(), bases: found };
          loading = null;
          return found;
        });
    }
    return loading;
  }
  return async function baseOf(provider: string | null | undefined): Promise<string | null> {
    if (!provider || !PROVIDER_ID.test(provider)) return null;
    const custom = (await bases()).get(provider);
    if (custom) return custom;
    return BUILTIN_PROVIDERS.includes(provider) ? provider : null;
  };
}

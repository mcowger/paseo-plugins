import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type Api = PluginHandlerContext["paseo"];
type Borrowed = Api & { dispose(): Promise<void> };
/** Paseo 0.13 `paseo.hosts` (connected hosts). Older daemons have none, and no Agent there runs on another host. */
interface Hosts {
  list(): Promise<{ self: { serverId: string }; hosts: ReadonlyArray<{ serverId: string | null; label: string | null }> }>;
  client(serverId: string): Promise<Borrowed>;
}
interface Entry { api: Promise<Borrowed>; users: number; timer: ReturnType<typeof setTimeout> | null }
interface Routes { directory: { at: number; value: Promise<Awaited<ReturnType<Hosts["list"]>> | null> } | null; entries: Map<string, Entry> }

/** Where a child runs: here, on another host this daemon reaches (its API, borrowed until `release`), or out of reach. */
export type HostRoute =
  | { kind: "local" }
  | { kind: "remote"; api: Api; host: string; release(broken: boolean): void }
  | { kind: "offline"; host: string };

const LOCAL: HostRoute = { kind: "local" };
const DIRECTORY_MS = 60_000;
const routes = new WeakMap<object, Routes>();

/**
 * Paseo 0.13 connected hosts: an Agent can create its child on another host, and only that host can read the child.
 * This daemon reaches it the way Paseo's own `create_agent` did, through `paseo.hosts.client(serverId)`; the borrowed
 * API stays while cards read and goes after `idleMs` without a read. A child named by this host's own server id, or
 * read where the host list cannot be had, is read here as before.
 */
export async function hostRoute(paseo: Api, serverId: string | undefined, options: { idleMs?: number; connectMs?: number; now?: () => number } = {}): Promise<HostRoute> {
  const hosts = (paseo as unknown as { hosts?: Hosts }).hosts;
  if (!serverId || !hosts || typeof hosts.list !== "function" || typeof hosts.client !== "function") return LOCAL;
  const now = options.now ?? Date.now;
  let state = routes.get(paseo);
  if (!state) { state = { directory: null, entries: new Map() }; routes.set(paseo, state); }
  if (!state.directory || now() - state.directory.at > DIRECTORY_MS) {
    const value = hosts.list().catch(() => null);
    state.directory = { at: now(), value };
    void value.then((directory) => { if (!directory && state!.directory?.value === value) state!.directory = null; });
  }
  const directory = await state.directory.value;
  if (!directory || directory.self.serverId === serverId) return LOCAL;
  const listed = directory.hosts.find((entry) => entry.serverId === serverId);
  // The card shows the name beside its title; a long one would only crowd out the rows under the summary's byte cap.
  const host = [...(listed?.label?.trim() || serverId)].slice(0, 48).join("");
  if (!listed) return { kind: "offline", host };
  let entry = state.entries.get(serverId);
  if (!entry) {
    const connectMs = options.connectMs ?? 8_000;
    const api = new Promise<Borrowed>((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => { late = true; reject(new Error("host_offline")); }, connectMs);
      hosts.client(serverId).then((borrowed) => {
        clearTimeout(timer);
        if (late) void borrowed.dispose().catch(() => undefined);
        else resolve(borrowed);
      }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
    entry = { api, users: 0, timer: null };
    state.entries.set(serverId, entry);
  }
  const current = entry;
  current.users += 1;
  if (current.timer !== null) { clearTimeout(current.timer); current.timer = null; }
  const drop = () => {
    if (state!.entries.get(serverId) === current) state!.entries.delete(serverId);
    if (current.timer !== null) { clearTimeout(current.timer); current.timer = null; }
    void current.api.then((borrowed) => borrowed.dispose()).catch(() => undefined);
  };
  let api: Borrowed;
  try {
    api = await current.api;
  } catch {
    current.users -= 1;
    drop();
    return { kind: "offline", host };
  }
  let released = false;
  return {
    kind: "remote", api, host,
    release(broken) {
      if (released) return;
      released = true;
      current.users -= 1;
      // A lost route answers nothing more: the next read connects again.
      if (broken) { drop(); return; }
      if (current.users === 0 && state!.entries.get(serverId) === current) current.timer = setTimeout(drop, options.idleMs ?? 60_000);
    },
  };
}

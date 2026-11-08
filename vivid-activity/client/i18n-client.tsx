import { useEffect, useState } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  bindTranslator,
  createTranslator,
  FALLBACK_LANGUAGE,
  normalizeLanguage,
  SOURCE_LANGUAGE,
  onTextChange,
  t,
  translator,
  type Catalog,
  type TextSource,
  type Translator,
  setTextSource,
} from "../shared/i18n";
import { i18nCatalogRpc, LANGUAGE_SETTINGS_ID } from "../shared/i18n-rpc";
import { kitLazy as kitLazyEn, kitText as kitTextEn } from "../shared/locales/kit/en.json";
import { kitLazy as kitLazyZh, kitText as kitTextZh } from "../shared/locales/kit/zh-CN.json";

/**
 * A plugin's text on the client. The resident stub creates one at start: it speaks the bundled boot text (titles that
 * show before anything loads) in the device's language at once, asks the plugin server for its text in the chosen
 * language, and swaps it in: the full catalog at once ("eager"), or ("lazy") only the boot text now and the full
 * catalog when something waits for `ready()`, like a lazy chunk opening. The full catalog is kept for the app session
 * (and in localStorage on web and desktop), so a reconnect or reload shows it at once and only checks that it is still
 * current. Lazy chunks get it through `lazySurfaces({ text })` and follow it.
 */
export interface ClientI18n extends TextSource {
  /** Whether the full catalog (not just boot text) is in use. */
  isReady(): boolean;
  /** Ask the server again: after the language setting, a language file or the device language changed. */
  refresh(): Promise<void>;
  /**
   * For contributions whose words the host copies once (command center items, slash commands): registers them now
   * and again whenever the language changes. Screens take a title function instead; panels keep their first title.
   */
  localized(register: () => Cleanup | readonly Cleanup[]): Cleanup;
  dispose(): void;
}
type Cleanup = () => void;
type Cached = { language: string; hash: string; catalog: Catalog };

const CACHE_KEY = "__paseoI18nCatalogsV1";
const globalStore = globalThis as unknown as Record<string, Map<string, Cached> | undefined>;
// Data only, like the chunk texts: a catalog never holds a client, so one connection cannot leak into the next.
const catalogs = globalStore[CACHE_KEY] ?? (globalStore[CACHE_KEY] = new Map<string, Cached>());
const STORAGE_PREFIX = "paseo-i18n-v1:";
interface TextStorage { getItem(name: string): string | null; setItem(name: string, value: string): void; removeItem?(name: string): void }

/** The browser's localStorage on web and desktop, so a reload starts in the chosen language; null on the phone. */
function textStorage(): TextStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: TextStorage }).localStorage;
    return candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function" ? candidate : null;
  } catch {
    return null;
  }
}

function storedCatalog(pluginId: string): Cached | undefined {
  try {
    const value = JSON.parse(textStorage()?.getItem(STORAGE_PREFIX + pluginId) ?? "null") as Partial<Cached> | null;
    if (value && typeof value.language === "string" && typeof value.hash === "string" && /^[0-9a-f]{16}$/.test(value.hash) && value.catalog && typeof value.catalog === "object") return value as Cached;
  } catch {
    // Unreadable or blocked storage: start from the boot text.
  }
  return undefined;
}

function storeCatalog(pluginId: string, value: Cached): void {
  try {
    textStorage()?.setItem(STORAGE_PREFIX + pluginId, JSON.stringify(value));
  } catch {
    // Full or blocked storage only costs the next reload a moment of boot text.
  }
}

function forgetCatalog(pluginId: string): void {
  catalogs.delete(pluginId);
  try {
    textStorage()?.removeItem?.(STORAGE_PREFIX + pluginId);
  } catch {
    // Blocked storage: the next start shows the old text until the server answers, as before.
  }
}
const KIT_BOOT: { readonly [language: string]: Catalog } = {
  "zh-CN": { kitLazy: kitLazyZh, kitText: kitTextZh },
  en: { kitLazy: kitLazyEn, kitText: kitTextEn },
};

/** The device's language as a BCP 47 tag; "" when neither Intl nor the browser says. */
export function deviceLanguage(): string {
  try {
    const tag = normalizeLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
    if (tag) return tag;
  } catch {
    // Hermes without Intl: ask the browser, if there is one.
  }
  try {
    const browser = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
    return normalizeLanguage(browser?.languages?.[0] ?? browser?.language ?? "");
  } catch {
    return "";
  }
}

type SettingsObserver = (
  events: ["status.plugin_settings_changed"],
  options: { signal: AbortSignal },
) => { subscribe(observer: { snapshot(): void; update(message: unknown): void; error?(error: unknown): void }): () => void; release(): Promise<void> };

function isLanguageChange(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const { type, payload } = message as { type?: unknown; payload?: { status?: unknown; settingsId?: unknown } | null };
  // Any plugin's language setting: the event names the installed id, which a plugin cannot know for sure. Asking
  // again costs one "unchanged" reply.
  return type === "status" && payload?.status === "plugin_settings_changed" && payload.settingsId === LANGUAGE_SETTINGS_ID;
}

/** Calls `changed` after a language setting changes on any device (`false`), and after every (re)connect (`true`). */
function watchLanguageSetting(client: PluginClientContext, changed: (snapshot: boolean) => void): () => void {
  const observe = (client.paseo as { observeEvents?: unknown }).observeEvents;
  if (typeof observe !== "function") return () => undefined;
  const lifetime = new AbortController();
  try {
    const observation = (observe as SettingsObserver).call(client.paseo, ["status.plugin_settings_changed"], { signal: lifetime.signal });
    const unsubscribe = observation.subscribe({ snapshot: () => changed(true), update: (message) => { if (isLanguageChange(message)) changed(false); }, error: () => undefined });
    return () => {
      unsubscribe();
      lifetime.abort();
      void observation.release().catch(() => undefined);
    };
  } catch {
    lifetime.abort();
    return () => undefined;
  }
}

const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const asCleanup = (value: Cleanup | readonly Cleanup[]): Cleanup => (typeof value === "function" ? value : () => { for (const cleanup of value) cleanup(); });

export function createClientI18n(client: PluginClientContext, options: {
  /** The plugin's install id: keys the session cache. */
  pluginId: string;
  /** The plugin's own boot sections per built-in language (kit adds its own), e.g. `{ "zh-CN": { boot }, en: { boot } }`. */
  boot: { readonly [language: string]: Catalog };
  /**
   * "eager" (default) fetches the full catalog at start, for a resident stub that draws translated text itself.
   * "lazy" fetches only the boot text in the chosen language at start (a few hundred bytes) and the full catalog when
   * something waits for `ready()`, so a device that never opens the plugin's views never downloads it.
   */
  load?: "eager" | "lazy";
}): ClientI18n {
  const device = deviceLanguage();
  // Boot text exists in Chinese and English only: Chinese for any Chinese device, English for everyone else.
  const bootLanguage = /^zh(-|$)/.test(device) && options.boot[SOURCE_LANGUAGE] ? SOURCE_LANGUAGE : FALLBACK_LANGUAGE;
  const bootLayers = [options.boot[bootLanguage] ?? {}, KIT_BOOT[bootLanguage] ?? KIT_BOOT[FALLBACK_LANGUAGE]!];
  let current: Translator = createTranslator(bootLanguage, bootLayers, { missing: "empty" });
  let full = false, wanted = options.load !== "lazy";
  const cached = catalogs.get(options.pluginId) ?? storedCatalog(options.pluginId);
  if (cached) {
    // A kept catalog may predate a plugin update: an id it lacks reads as nothing until the server's answer arrives.
    catalogs.set(options.pluginId, cached);
    current = createTranslator(cached.language, [cached.catalog, ...bootLayers], { hash: cached.hash, missing: "empty" });
    full = true;
  }
  bindTranslator(current);
  let markReady: () => void = () => undefined;
  let ready = new Promise<void>((resolve) => { markReady = resolve; });
  if (full) markReady();
  const listeners = new Set<() => void>();
  let disposed = false, running: Promise<void> | null = null, again = false, failures = 0, snapshots = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const show = (next: Translator) => {
    if (disposed) return;
    current = next;
    bindTranslator(next);
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // A broken registration must not keep the rest in the old language.
      }
    }
  };
  const apply = (next: Translator) => {
    if (disposed) return;
    full = true;
    markReady();
    show(next);
  };
  const fetchBoot = async () => {
    const first = await client.rpc(i18nCatalogRpc, { device, have: full && current.hash ? current.hash : undefined, part: 0, scope: "boot" });
    if (first.status === "unchanged" || disposed) return;
    if (full) {
      // The kept catalog is out of date (another language, a plugin update): boot text now, the rest when needed.
      full = false;
      forgetCatalog(options.pluginId);
      ready = new Promise<void>((resolve) => { markReady = resolve; });
    }
    show(createTranslator(first.language, [JSON.parse(first.text) as Catalog, ...bootLayers], { hash: first.hash, missing: "empty" }));
  };
  const fetchCatalog = async () => {
    const first = await client.rpc(i18nCatalogRpc, { device, have: full && current.hash ? current.hash : undefined, part: 0 });
    if (first.status === "unchanged") return;
    let text = first.text;
    for (let part = 1; part < first.parts; part++) {
      const next = await client.rpc(i18nCatalogRpc, { device, hash: first.hash, part });
      if (next.status !== "ok" || next.hash !== first.hash || next.part !== part || next.parts !== first.parts) throw new Error("The language catalog changed while loading.");
      text += next.text;
    }
    const catalog = JSON.parse(text) as Catalog;
    const fresh = { language: first.language, hash: first.hash, catalog };
    catalogs.set(options.pluginId, fresh);
    storeCatalog(options.pluginId, fresh);
    apply(createTranslator(first.language, [catalog, ...bootLayers], { hash: first.hash }));
  };
  const retryLater = () => {
    if (disposed || timer) return;
    const delay = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]!;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, delay);
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = (wanted ? fetchCatalog() : fetchBoot()).then(() => { failures = 0; }, () => {
      failures += 1;
      retryLater();
    }).then(() => {
      running = null;
      if (again && !disposed) {
        again = false;
        void refresh();
      }
    });
    return running;
  };
  // The first snapshot comes with the start, which asks already; later ones follow a reconnect.
  const stopWatching = watchLanguageSetting(client, (snapshot) => { if (!snapshot || snapshots++ > 0) void refresh(); });
  void refresh();

  const store: ClientI18n = {
    ready: () => {
      if (!wanted && !disposed) {
        wanted = true;
        void refresh();
      }
      return ready;
    },
    isReady: () => full,
    translator: () => current,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    localized(register) {
      let cleanup = asCleanup(register());
      let shown = `${current.language}:${current.hash}`;
      const redo = () => {
        const now = `${current.language}:${current.hash}`;
        if (now === shown) return;
        shown = now;
        cleanup();
        cleanup = asCleanup(register());
      };
      listeners.add(redo);
      return () => {
        listeners.delete(redo);
        cleanup();
      };
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      listeners.clear();
      stopWatching();
    },
  };
  setTextSource(store);
  return store;
}

/** Redraws the calling component when the language or catalog changes; returns `t` and the language spoken. */
export function useI18n(): { t: typeof t; language: string } {
  const [, setChanges] = useState(0);
  useEffect(() => onTextChange(() => setChanges((value) => value + 1)), []);
  return { t, language: translator().language };
}

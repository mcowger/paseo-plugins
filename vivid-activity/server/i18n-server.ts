import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  assembleCatalog,
  bindTranslator,
  catalogIds,
  catalogName,
  checkCatalog,
  createTranslator,
  FALLBACK_LANGUAGE,
  normalizeLanguage,
  resolveLanguage,
  SOURCE_LANGUAGE,
  type Catalog,
  type CatalogCheck,
  type CatalogIssue,
} from "../shared/i18n";
import { i18nCatalogRpc } from "../shared/i18n-rpc";
import { i18nLanguagesRpc, languageSettings } from "../shared/i18n-settings";
import { splitReply } from "./client-chunks";

/**
 * The plugin's languages on the server: the built-in catalogs, the user's own files, the Language setting, the two
 * RPCs and the translator for text the server writes itself. Copied to `<plugin>/server/i18n-server.ts`.
 *
 * Users add a language as `<code>.json` in `$PASEO_HOME/plugin-data/<plugin id>/locales/`. The service keeps
 * `templates/en.json`, `templates/zh-CN.json` and a README there, and reads the folder when a client asks (no file
 * watching: the account's inotify instances are scarce). Only messages the plugin has are used, each checked against
 * its English placeholders; anything missing or unusable shows in English.
 */
export interface LocaleOptions {
  /** The plugin's install id, as in its `plugin-data` folder. */
  pluginId: string;
  /** Per built-in language, its catalogs in order (the plugin's own, then kit's). Must include zh-CN and en. */
  builtins: { readonly [language: string]: readonly Catalog[] };
  /** The daemon's home; default PASEO_HOME, else ~/.paseo (tests pass a temporary folder). */
  home?: string;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface LocaleService {
  /** The language the server writes in: the chosen one, else the last device that asked, else English. */
  language(): string;
  folder: string;
  /** Resolves once the setting, the folder and the server's translator are in place. */
  ready: Promise<void>;
  dispose(): void;
}

const FILE = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3})\.json$/;
const MAX_FILES = 40;
const MAX_BYTES = 2 * 1024 * 1024;
/** A reply must stay under the host's RPC message size (kit client-chunks leaves 8 KiB of 128 for the envelope). */
const PART_BYTES = 100 * 1024;
const KEEP_BUILT = 8;
/** What a client shows before it needs the rest: the plugin's `boot` section and kit's lazy-loading words. */
const BOOT_SECTIONS = ["boot", "kitLazy", "kitText"];

interface CustomFile { code: string; file: string; check: CatalogCheck; signature: string }
interface Built { language: string; hash: string; text: string; catalog: Catalog; parts?: string[]; boot?: { hash: string; text: string } }

/** The boot text of a built catalog, kept with it: small enough for one reply, with its own hash. */
function bootOf(entry: Built): { hash: string; text: string } {
  if (!entry.boot) {
    const subset: { [section: string]: Catalog[string] } = {};
    for (const section of BOOT_SECTIONS) if (entry.catalog[section]) subset[section] = entry.catalog[section];
    const text = JSON.stringify(subset);
    entry.boot = { text, hash: createHash("sha256").update(`boot\n${entry.language}\n${text}`).digest("hex").slice(0, 16) };
  }
  return entry.boot;
}

/** `PASEO_HOME` (a leading `~` expands), else Paseo's default `~/.paseo`. */
export function paseoHome(env: Record<string, string | undefined> = process.env): string {
  let home = env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  if (home === "~") home = homedir();
  else if (home.startsWith("~/")) home = join(homedir(), home.slice(2));
  return resolve(home);
}

// i18n-ignore: the folder's README speaks to translators in both languages on purpose.
const README = (pluginId: string) => `# Languages for ${pluginId}

Add a language by putting a translation in this folder as \`<language code>.json\`, for example \`ko.json\` or
\`pt-BR.json\`:

1. Copy \`templates/en.json\` (or \`templates/zh-CN.json\`) here and rename it.
2. Set \`"$meta": { "name": "..." }\` to the language's own name, for example "한국어".
3. Translate the values. Keep every \`{placeholder}\` as it is. Plural forms ("one", "other", ...) follow CLDR plural
   categories; "other" is required.
4. In the plugin's Language setting, pick your language, or keep "Follow system" if your device uses it.

Entries you leave out, or that cannot be used, show in English; the Language setting lists the problems it found.
A file named after a built-in language (\`en.json\`, \`zh-CN.json\`) changes only the entries it contains.
The templates are rewritten when the plugin updates: compare them with your file to find new messages.

# 自定义语言

把翻译文件以 \`<语言代码>.json\` 放进这个文件夹，例如 \`ko.json\`、\`pt-BR.json\`：

1. 把 \`templates/en.json\`（或 \`templates/zh-CN.json\`）复制到这里并改名。
2. 把 \`"$meta": { "name": "..." }\` 改成这种语言自己的名字，例如「한국어」。
3. 翻译各条的值，\`{占位符}\` 原样保留。单复数形式（"one"、"other" 等）按 CLDR 分类，必须有 "other"。
4. 在插件的「语言」设置里选这种语言；设备本来就用这种语言时，保持「跟随系统」即可。

没翻译或用不了的条目显示英文，「语言」设置会列出发现的问题。文件名和内置语言相同（\`en.json\`、\`zh-CN.json\`）时，
只替换文件里有的条目。插件更新时会重写模板，可以和自己的文件对比，找出新增的条目。
`;

const errorText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error ?? "").slice(0, 160);
const failed = (issue: CatalogIssue, total: number): CatalogCheck => ({ catalog: {}, translated: 0, total, unknown: 0, invalid: 0, issues: [issue] });

async function writeIfChanged(path: string, text: string): Promise<void> {
  const before = await readFile(path, "utf8").catch(() => null);
  if (before === text) return;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o644 });
  await rename(temporary, path);
}

/** Reads a regular file without following a link at its name, up to `limit` bytes. */
async function readRegularFile(path: string, limit: number): Promise<{ text: string; signature: string } | { error: CatalogIssue }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ELOOP" ? { code: "link" } : { code: "open", detail: errorText(error) } };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { error: { code: "notFile" } };
    if (info.size > limit) return { error: { code: "tooBig" } };
    const text = await handle.readFile("utf8");
    return { text, signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` };
  } finally {
    await handle.close();
  }
}

export function createLocaleService(server: PluginServerContext, options: LocaleOptions): LocaleService {
  const english = options.builtins[FALLBACK_LANGUAGE], chinese = options.builtins[SOURCE_LANGUAGE];
  if (!english?.length || !chinese?.length) throw new Error("i18n: the built-in zh-CN and en catalogs are required");
  const base = join(options.home ?? paseoHome(), "plugin-data", options.pluginId);
  const folder = join(base, "locales");
  const statePath = join(base, "i18n-state.json");
  const builtinCodes = Object.keys(options.builtins);
  const ids = Array.from(new Set([...english.flatMap(catalogIds), ...chinese.flatMap(catalogIds)]));
  // Users translate the English; a message's placeholders are checked against it.
  const reference = assembleCatalog([...english, ...chinese], ids);
  const log = options.log ?? (() => undefined);
  const fileCache = new Map<string, CustomFile>();
  const built = new Map<string, Built>();
  const byHash = new Map<string, Built>();

  let setting = "auto", device = "";
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { device?: unknown; setting?: unknown };
    device = normalizeLanguage(saved.device);
    if (typeof saved.setting === "string" && saved.setting.length <= 40) setting = saved.setting;
  } catch {
    // First start, or an unreadable state file: follow the next device that asks.
  }
  let disposed = false;

  const remember = () => {
    void mkdir(base, { recursive: true })
      .then(() => writeIfChanged(statePath, `${JSON.stringify({ device, setting })}\n`))
      .catch((error) => log("i18n: cannot save the language state", { error: errorText(error) }));
  };

  // The user's files as last read: lets a setting or device change take effect at once, before the folder is read again.
  let lastScan = new Map<string, CustomFile>();
  const scan = async (): Promise<Map<string, CustomFile>> => {
    const found = new Map<string, CustomFile>();
    let names: string[];
    try {
      names = (await readdir(folder)).filter((name) => FILE.test(name)).sort().slice(0, MAX_FILES);
    } catch {
      return found;
    }
    for (const file of names) {
      const code = normalizeLanguage(FILE.exec(file)![1]);
      if (!code || found.has(code)) continue;
      const read = await readRegularFile(join(folder, file), MAX_BYTES);
      if ("error" in read) {
        found.set(code, { code, file, check: failed(read.error, ids.length), signature: "" });
        continue;
      }
      const cached = fileCache.get(file);
      if (cached && cached.signature === read.signature) {
        found.set(code, cached);
        continue;
      }
      let check: CatalogCheck;
      try {
        check = checkCatalog(JSON.parse(read.text), reference);
      } catch (error) {
        check = failed({ code: "badJson", detail: errorText(error) }, ids.length);
      }
      const entry = { code, file, check, signature: read.signature };
      fileCache.set(file, entry);
      found.set(code, entry);
    }
    for (const file of Array.from(fileCache.keys())) if (!names.includes(file)) fileCache.delete(file);
    lastScan = found;
    return found;
  };

  const available = (customs: Map<string, CustomFile>) => {
    const codes = [...builtinCodes];
    for (const [code, custom] of customs) if (!codes.includes(code) && custom.check.translated > 0) codes.push(code);
    return codes;
  };

  const build = (language: string, custom: CustomFile | undefined): Built => {
    const cacheKey = `${language}\n${custom?.signature ?? ""}`;
    const existing = built.get(cacheKey);
    if (existing) return existing;
    const layers: Catalog[] = [], languages: string[] = [];
    const add = (from: string, catalogs: readonly Catalog[]) => { for (const catalog of catalogs) { layers.push(catalog); languages.push(from); } };
    if (custom) add(language, [custom.check.catalog]);
    add(language, options.builtins[language] ?? []);
    add(FALLBACK_LANGUAGE, english);
    add(SOURCE_LANGUAGE, chinese);
    const catalog = assembleCatalog(layers, ids, { language, languages });
    const text = JSON.stringify(catalog);
    const hash = createHash("sha256").update(`${language}\n${text}`).digest("hex").slice(0, 16);
    const entry: Built = { language, hash, text, catalog };
    built.set(cacheKey, entry);
    byHash.set(hash, entry);
    while (built.size > KEEP_BUILT) {
      const oldest = built.keys().next().value as string;
      byHash.delete(built.get(oldest)!.hash);
      built.delete(oldest);
    }
    return entry;
  };

  let serverHash = "", serverLanguage = FALLBACK_LANGUAGE;
  const bindServer = (entry: Built) => {
    if (disposed || entry.hash === serverHash) return;
    serverHash = entry.hash;
    serverLanguage = entry.language;
    bindTranslator(createTranslator(entry.language, [entry.catalog], { hash: entry.hash }));
  };
  const current = async (forDevice: string) => {
    const customs = await scan();
    const language = resolveLanguage(setting, forDevice || undefined, available(customs));
    return build(language, customs.get(language));
  };
  const rebind = async () => {
    try {
      bindServer(await current(device));
    } catch (error) {
      log("i18n: cannot load the language files", { error: errorText(error) });
    }
  };
  /** Switches at once with what is known (built-in languages, the files as last read), then reads the folder again. */
  const switchNow = () => {
    const language = resolveLanguage(setting, device || undefined, available(lastScan));
    bindServer(build(language, lastScan.get(language)));
    void rebind();
  };
  const noteDevice = (raw: string) => {
    const tag = normalizeLanguage(raw);
    if (!tag || tag === device) return;
    device = tag;
    remember();
    switchNow();
  };

  // Speak at once with the built-in catalogs, then with the setting and the user's files.
  bindServer(build(resolveLanguage(setting, device || undefined, builtinCodes), undefined));
  const settings = server.registerSettings(languageSettings);
  const adopt = (state: { status: string; values?: { language?: unknown } }) => {
    const next = state.status === "ready" && typeof state.values?.language === "string" ? state.values.language : "auto";
    if (next === setting) return;
    setting = next;
    remember();
    switchNow();
  };
  const stopSettings = settings.subscribe((state) => adopt(state as { status: string; values?: { language?: unknown } }));

  const prepare = async () => {
    await mkdir(join(folder, "templates"), { recursive: true });
    const englishCatalog = assembleCatalog(english, ids);
    const chineseCatalog = assembleCatalog(chinese, ids);
    await writeIfChanged(join(folder, "templates", "en.json"), `${JSON.stringify({ $meta: { name: "English" }, ...englishCatalog }, null, 2)}\n`);
    await writeIfChanged(join(folder, "templates", "zh-CN.json"), `${JSON.stringify({ $meta: { name: "简体中文" }, ...chineseCatalog }, null, 2)}\n`); // i18n-ignore: the template's own name
    await writeIfChanged(join(folder, "README.md"), README(options.pluginId));
  };
  const ready = Promise.all([
    settings.read().then(adopt, (error) => log("i18n: cannot read the language setting", { error: errorText(error) })),
    prepare().catch((error) => log("i18n: cannot prepare the language folder", { folder, error: errorText(error) })),
  ]).then(rebind);

  server.handle(i18nCatalogRpc, async (input) => {
    noteDevice(input.device);
    if (input.part > 0) {
      const entry = input.hash ? byHash.get(input.hash) : undefined;
      if (!entry) throw new Error("The language catalog changed; load it again.");
      const parts = entry.parts ?? (entry.parts = splitReply(entry.text, PART_BYTES));
      if (input.part >= parts.length) throw new Error("Unknown language catalog part.");
      return { status: "ok" as const, language: entry.language, hash: entry.hash, part: input.part, parts: parts.length, text: parts[input.part]! };
    }
    const entry = await current(normalizeLanguage(input.device) || device);
    if (normalizeLanguage(input.device) === device) bindServer(entry);
    if (input.have === entry.hash) return { status: "unchanged" as const, language: entry.language, hash: entry.hash };
    if (input.scope === "boot") {
      const boot = bootOf(entry);
      return { status: "ok" as const, language: entry.language, hash: boot.hash, part: 0, parts: 1, text: boot.text };
    }
    const parts = entry.parts ?? (entry.parts = splitReply(entry.text, PART_BYTES));
    return { status: "ok" as const, language: entry.language, hash: entry.hash, part: 0, parts: parts.length, text: parts[0]! };
  });

  server.handle(i18nLanguagesRpc, async (input) => {
    noteDevice(input.device);
    const customs = await scan();
    const asked = normalizeLanguage(input.device) || device;
    const languages = builtinCodes.map((code) => {
      const custom = customs.get(code);
      const name = custom?.check.name ?? options.builtins[code]!.map(catalogName).find(Boolean) ?? code;
      return { code, name, builtIn: true, custom: Boolean(custom), file: custom?.file, coverage: 1, issues: custom?.check.issues ?? [] };
    });
    for (const [code, custom] of customs) {
      if (builtinCodes.includes(code)) continue;
      const coverage = custom.check.total ? custom.check.translated / custom.check.total : 0;
      languages.push({ code, name: custom.check.name ?? code, builtIn: false, custom: true, file: custom.file, coverage, issues: custom.check.issues });
    }
    void rebind();
    const codes = available(customs);
    return { setting, resolved: resolveLanguage(setting, asked || undefined, codes), system: resolveLanguage("auto", asked || undefined, codes), device: asked, folder, languages };
  });

  return {
    language: () => serverLanguage,
    folder,
    ready,
    dispose() {
      disposed = true;
      stopSettings();
    },
  };
}

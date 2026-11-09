/**
 * Plugin text in any language: message catalogs, formatting and the translator this bundle speaks with. Copied to
 * `<plugin>/shared/i18n.ts` by `npm run kit:sync`. Pure (no React, no Node APIs) and safe for the phone app's default
 * Hermes: no classes, no top-level `key`/`from`, no loop closures that run after their iteration.
 *
 * A catalog is JSON: `{ "$meta": { "name": "English" }, "<section>": { "<name>": message } }`. A message id is
 * `"<section>.<name>"`, both identifiers. A message is text with `{placeholder}`s, or plural forms such as
 * `{ "one": "{count} step", "other": "{count} steps" }` picked by `params.count` (CLDR categories, "other" required).
 */
import { kitText as kitTextZh } from "./locales/kit/zh-CN.json";

export type PluralForms = { readonly [category: string]: string };
export type Message = string | PluralForms;
export type Section = { readonly [name: string]: Message };
export interface CatalogMeta { readonly name?: string }
export type Catalog = { readonly [section: string]: Section | CatalogMeta | undefined };
export type ParamValue = string | number | boolean | null | undefined;
export type Params = { readonly [name: string]: ParamValue };
/** A formatted message cut at its placeholders, for text that styles the values (bold names, links). */
export interface TextPart { text: string; param?: string }

/** The language the plugins were written in. A bundle that never binds a translator (private plugins) speaks it. */
export const SOURCE_LANGUAGE = "zh-CN";
/** Messages a language lacks show in this one. */
export const FALLBACK_LANGUAGE = "en";
export const PLURAL_CATEGORIES: readonly string[] = ["zero", "one", "two", "few", "many", "other"];
export const META_SECTION = "$meta";
/**
 * In a served catalog, plural forms that fell back to another language carry that language here, so "1 step" is
 * chosen by English rules inside a Korean catalog. Catalog files never need it.
 */
export const FORMS_LANGUAGE = "$language";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const hasOwn = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);
const isObject = (value: unknown): value is { readonly [name: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value);

export function isPluralForms(value: unknown): value is PluralForms {
  if (!isObject(value) || !hasOwn(value, "other")) return false;
  const names = Object.keys(value);
  return names.every((name) => (PLURAL_CATEGORIES.includes(name) || name === FORMS_LANGUAGE) && typeof value[name] === "string");
}

/** The text of every form (never `$language`). */
const formTexts = (forms: PluralForms) => Object.keys(forms).filter((name) => name !== FORMS_LANGUAGE).map((name) => forms[name]!);

export const isMessage = (value: unknown): value is Message => typeof value === "string" || isPluralForms(value);

/** `["fold", "stepsBefore"]` for `"fold.stepsBefore"`; null for anything that is not `<identifier>.<identifier>`. */
export function splitId(id: string): [string, string] | null {
  const at = id.indexOf(".");
  if (at <= 0) return null;
  const section = id.slice(0, at), name = id.slice(at + 1);
  return IDENTIFIER.test(section) && IDENTIFIER.test(name) ? [section, name] : null;
}

/** The message under `id` in one catalog, or undefined. Own properties only: catalog keys come from files. */
export function lookup(catalog: Catalog, id: string): Message | undefined {
  const at = id.indexOf(".");
  if (at <= 0) return undefined;
  const section = id.slice(0, at), name = id.slice(at + 1);
  if (section === META_SECTION || !hasOwn(catalog, section)) return undefined;
  const entries = catalog[section];
  if (!isObject(entries) || !hasOwn(entries, name)) return undefined;
  const message = (entries as Section)[name];
  return isMessage(message) ? message : undefined;
}

/** Every message id of a catalog, in file order. */
export function catalogIds(catalog: Catalog): string[] {
  const ids: string[] = [];
  for (const section of Object.keys(catalog)) {
    const entries = catalog[section];
    if (section === META_SECTION || !IDENTIFIER.test(section) || !isObject(entries)) continue;
    for (const name of Object.keys(entries)) if (IDENTIFIER.test(name) && isMessage(entries[name])) ids.push(`${section}.${name}`);
  }
  return ids;
}

/** The catalog's own name for its language (`$meta.name`), or undefined. */
export function catalogName(catalog: Catalog | undefined): string | undefined {
  const meta = catalog && hasOwn(catalog, META_SECTION) ? catalog[META_SECTION] : undefined;
  const name = isObject(meta) ? meta.name : undefined;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : undefined;
}

const pluralRules = new Map<string, (count: number) => string>();

function makePluralRule(language: string): (count: number) => string {
  try {
    const rules = new Intl.PluralRules(language);
    if (typeof rules.select(1) === "string") return (count) => rules.select(count);
  } catch {
    // Hermes builds without Intl.PluralRules: the rules below cover the common shapes.
  }
  const primary = language.split("-")[0]!.toLowerCase();
  if (["zh", "ja", "ko", "vi", "th", "id", "ms", "lo", "my", "km", "yue"].includes(primary)) return () => "other";
  if (primary === "fr" || primary === "pt") return (count) => (count < 2 ? "one" : "other");
  return (count) => (count === 1 ? "one" : "other");
}

/** The CLDR plural category of `count` in `language` ("one", "few", "other", ...). */
export function pluralCategory(language: string, count: number): string {
  if (!Number.isFinite(count)) return "other";
  let rule = pluralRules.get(language);
  if (!rule) {
    rule = makePluralRule(language);
    pluralRules.set(language, rule);
  }
  return rule(Math.abs(count));
}

function pickForm(message: Message, params: Params | undefined, language: string): string {
  if (typeof message === "string") return message;
  const category = pluralCategory(message[FORMS_LANGUAGE] ?? language, Number(params?.count));
  return hasOwn(message, category) ? message[category]! : message.other!;
}

const paramText = (value: ParamValue) => (value === undefined || value === null ? "" : String(value));

/** Fills `{name}` placeholders. A placeholder without a param stays visible, so a missed value shows in review. */
export function format(message: Message, params?: Params, language: string = SOURCE_LANGUAGE): string {
  const text = pickForm(message, params, language);
  if (!params || text.indexOf("{") < 0) return text;
  return text.replace(PLACEHOLDER, (whole: string, name: string) => (hasOwn(params, name) ? paramText(params[name]) : whole));
}

/** Like `format`, cut into literal text and filled values. */
export function formatParts(message: Message, params?: Params, language: string = SOURCE_LANGUAGE): TextPart[] {
  const text = pickForm(message, params, language);
  const parts: TextPart[] = [];
  let last = 0;
  text.replace(PLACEHOLDER, (whole: string, name: string, offset: number) => {
    if (!params || !hasOwn(params, name)) return whole;
    if (offset > last) parts.push({ text: text.slice(last, offset) });
    parts.push({ text: paramText(params[name]), param: name });
    last = offset + whole.length;
    return whole;
  });
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** The placeholder names a message uses, in any of its plural forms, sorted. */
export function placeholdersOf(message: Message): string[] {
  const texts = typeof message === "string" ? [message] : formTexts(message);
  const names = new Set<string>();
  for (const text of texts) for (const match of text.match(PLACEHOLDER) ?? []) names.add(match.slice(1, -1));
  return Array.from(names).sort();
}

const LANGUAGE_SUBTAG = /^[A-Za-z0-9]{1,8}$/;

/**
 * A BCP 47 tag in canonical case without extensions: "zh_hans_cn" → "zh-Hans-CN", "en-US-u-hc-h12" → "en-US".
 * "" for anything that is not a language tag (including "C" and "POSIX").
 */
export function normalizeLanguage(tag: unknown): string {
  if (typeof tag !== "string") return "";
  const parts = tag.trim().replace(/_/g, "-").split(/[.@]/)[0]!.split("-");
  const kept: string[] = [];
  for (const part of parts) {
    if (part.length === 1 && kept.length) break; // -u-, -x- and other extensions
    if (!LANGUAGE_SUBTAG.test(part)) return "";
    kept.push(part);
  }
  if (!kept.length || !/^[A-Za-z]{2,3}$/.test(kept[0]!) || kept.length > 4) return "";
  return kept.map((part, index) => {
    if (index === 0) return part.toLowerCase();
    if (part.length === 4 && /^[A-Za-z]+$/.test(part)) return part[0]!.toUpperCase() + part.slice(1).toLowerCase();
    if (part.length === 2 && /^[A-Za-z]+$/.test(part)) return part.toUpperCase();
    return part.toLowerCase();
  }).join("-");
}

const isTraditionalChinese = (tag: string) => /-(Hant|TW|HK|MO)(-|$)/i.test(tag);

/**
 * The best of `available` for a wanted language: the same tag, then the same language (Chinese by script: zh-TW and
 * zh-Hant prefer a traditional catalog, everything else a simplified one, either falls back to the other), then the
 * same region, then the bare language. Null when no catalog speaks that language.
 */
export function matchLanguage(wanted: string, available: readonly string[]): string | null {
  const tag = normalizeLanguage(wanted);
  if (!tag) return null;
  const lower = tag.toLowerCase();
  const exact = available.find((code) => code.toLowerCase() === lower);
  if (exact) return exact;
  const parts = tag.split("-"), primary = parts[0]!;
  const candidates = available.filter((code) => code.split("-")[0]!.toLowerCase() === primary);
  if (!candidates.length) return null;
  if (primary === "zh") {
    const traditional = isTraditionalChinese(tag);
    return candidates.find((code) => isTraditionalChinese(code) === traditional) ?? candidates[0]!;
  }
  const region = parts.length > 1 ? parts[parts.length - 1]! : "";
  const sameRegion = region.length === 2 ? candidates.find((code) => code.split("-").includes(region)) : undefined;
  return sameRegion ?? candidates.find((code) => !code.includes("-")) ?? candidates[0]!;
}

/** The language to speak: the chosen one when a catalog has it, else the device's, else English. */
export function resolveLanguage(setting: string | undefined, device: string | undefined, available: readonly string[]): string {
  if (setting && setting !== "auto") {
    const chosen = matchLanguage(setting, available);
    if (chosen) return chosen;
  }
  const fromDevice = device ? matchLanguage(device, available) : null;
  if (fromDevice) return fromDevice;
  return available.includes(FALLBACK_LANGUAGE) ? FALLBACK_LANGUAGE : available[0] ?? FALLBACK_LANGUAGE;
}

/**
 * One catalog holding, for every id of `ids` (default: all ids of all layers), the first layer's message. With
 * `languages` (one per layer) and the catalog's `language`, plural forms taken from a layer in another language are
 * marked with it (`$language`), so their counts follow that language's rules.
 */
export function assembleCatalog(layers: readonly Catalog[], ids?: readonly string[], options: { language?: string; languages?: readonly string[] } = {}): Catalog {
  const out: { [section: string]: { [name: string]: Message } } = {};
  const wanted = ids ?? Array.from(new Set(layers.flatMap(catalogIds)));
  for (const id of wanted) {
    let message: Message | undefined, from = -1;
    for (let index = 0; index < layers.length; index++) {
      message = lookup(layers[index]!, id);
      if (message !== undefined) { from = index; break; }
    }
    const split = splitId(id);
    if (message === undefined || !split) continue;
    const source = options.languages?.[from];
    if (typeof message !== "string" && source && options.language && source !== options.language && !message[FORMS_LANGUAGE]) message = { ...message, [FORMS_LANGUAGE]: source };
    const section = out[split[0]] ?? (out[split[0]] = {});
    section[split[1]] = message;
  }
  return out;
}

/** What is wrong with (part of) a user's catalog; the Language setting words it (`kitLanguage.issue…`). */
export interface CatalogIssue {
  code: "notObject" | "notSection" | "unknownMessage" | "badShape" | "tooLong" | "badPlaceholder" | "link" | "open" | "notFile" | "tooBig" | "badJson";
  /** The message id or section concerned, shown as plain text. */
  id?: string;
  /** Placeholder names, or the system's error text. */
  detail?: string;
}

export interface CatalogCheck {
  /** The usable messages: known ids, valid shape, no placeholder the reference lacks. */
  catalog: Catalog;
  name?: string;
  translated: number;
  total: number;
  /** Ids the reference does not have (ignored). */
  unknown: number;
  /** Known ids whose message was unusable (ignored). */
  invalid: number;
  /** What was left out and why, for the settings page (at most 20). */
  issues: CatalogIssue[];
}

const MESSAGE_LIMIT = 4000;
const ISSUE_LIMIT = 20;
// Control characters other than tab and newline would garble a row; a file may still use any other text.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const shown = (value: string) => value.replace(/[^\x20-\x7e]/g, "?").slice(0, 60);

/**
 * Checks a user's translation against the reference catalog (the plugin's English). Unusable entries are left out,
 * never repaired, so the language falls back to English for them; `issues` says which and why.
 */
export function checkCatalog(input: unknown, reference: Catalog): CatalogCheck {
  const ids = catalogIds(reference);
  const result: CatalogCheck = { catalog: {}, translated: 0, total: ids.length, unknown: 0, invalid: 0, issues: [] };
  const note = (issue: CatalogIssue) => { if (result.issues.length < ISSUE_LIMIT) result.issues.push(issue); };
  if (!isObject(input)) {
    note({ code: "notObject" });
    return result;
  }
  result.name = catalogName(input as Catalog);
  const out: { [section: string]: { [name: string]: Message } } = {};
  for (const section of Object.keys(input)) {
    if (section === META_SECTION) continue;
    const entries = input[section];
    const known = hasOwn(reference, section) && isObject(reference[section]);
    if (!isObject(entries)) {
      result.invalid += 1;
      note({ code: "notSection", id: shown(section) });
      continue;
    }
    for (const name of Object.keys(entries)) {
      const id = `${section}.${name}`;
      const expected = known ? lookup(reference, id) : undefined;
      if (expected === undefined) {
        result.unknown += 1;
        note({ code: "unknownMessage", id: shown(id) });
        continue;
      }
      const message = entries[name];
      const texts = typeof message === "string" ? [message] : isPluralForms(message) && !hasOwn(message, FORMS_LANGUAGE) ? formTexts(message) : null;
      if (!texts) {
        result.invalid += 1;
        note({ code: "badShape", id });
        continue;
      }
      if (texts.some((text) => text.length > MESSAGE_LIMIT || CONTROL.test(text))) {
        result.invalid += 1;
        note({ code: "tooLong", id });
        continue;
      }
      const allowed = placeholdersOf(expected);
      const extra = placeholdersOf(message as Message).filter((placeholder) => !allowed.includes(placeholder));
      if (extra.length) {
        result.invalid += 1;
        note({ code: "badPlaceholder", id, detail: `{${extra.join("}, {")}}` });
        continue;
      }
      const target = out[section] ?? (out[section] = {});
      target[name] = message as Message;
      result.translated += 1;
    }
  }
  result.catalog = out;
  return result;
}

export interface Translator {
  readonly language: string;
  /** Content hash of the catalog behind it; "" for the built-in boot text. */
  readonly hash: string;
  t(id: string, params?: Params): string;
  message(id: string): Message | undefined;
}

/**
 * A translator over catalogs searched in order. A missing id reads as the id itself (`missing: "id"`, the default:
 * a bug shows in review) or as "" (`"empty"`, for boot text that only covers what shows before the catalog arrives).
 */
export function createTranslator(language: string, layers: readonly Catalog[], options: { hash?: string; missing?: "id" | "empty" } = {}): Translator {
  const showId = options.missing !== "empty";
  const message = (id: string): Message | undefined => {
    for (const layer of layers) {
      const found = lookup(layer, id);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return {
    language,
    hash: options.hash ?? "",
    t: (id, params) => {
      const found = message(id);
      return found === undefined ? (showId ? id : "") : format(found, params, language);
    },
    message,
  };
}

// --- This bundle's translator -------------------------------------------------------------------------------------
// Each bundle (a plugin's resident client, each lazy chunk, its server) has its own copy of this module, so binding a
// translator here never reaches another plugin or host.

const defaults: Catalog[] = [{ kitText: kitTextZh }];
const sourceTranslator = createTranslator(SOURCE_LANGUAGE, defaults, { missing: "empty" });
let bound: Translator | null = null;
const listeners = new Set<() => void>();

/** Kit modules register the Chinese they were written with; it is used only while no translator is bound. */
export function addDefaults(catalog: Catalog): void {
  if (!defaults.includes(catalog)) defaults.push(catalog);
}

/** Speaks `next` from now on (null: back to the source language) and tells every listener. */
export function bindTranslator(next: Translator | null): void {
  if (next === bound) return;
  bound = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // One broken view must not keep the others in the old language.
    }
  }
}

export const translator = (): Translator => bound ?? sourceTranslator;
export const t = (id: string, params?: Params): string => (bound ?? sourceTranslator).t(id, params);
/** Like `t`, cut at the placeholders (an unknown id reads as one part holding nothing). */
export function tParts(id: string, params?: Params): TextPart[] {
  const current = bound ?? sourceTranslator, found = current.message(id);
  return found === undefined ? [{ text: "" }] : formatParts(found, params, current.language);
}
export const currentLanguage = (): string => (bound ?? sourceTranslator).language;

/** Called after every change of language or catalog. */
export function onTextChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A translator that changes, e.g. the resident stub's `createClientI18n`. Lazy chunks wait for it and follow it. */
export interface TextSource {
  ready(): Promise<void>;
  translator(): Translator;
  subscribe(listener: () => void): () => void;
  /** Ask for the catalog again (after the language setting or a language file changed). */
  refresh?(): Promise<void>;
}

let textSource: TextSource | null = null;

/** Speaks whatever `source` speaks from now on: a lazy chunk calls this with the stub's text in `createSurfaces`. */
export function followText(source: TextSource | undefined): void {
  if (!source) return;
  textSource = source;
  bindTranslator(source.translator());
  source.subscribe(() => bindTranslator(source.translator()));
}

/** The bundle's text source, set by `createClientI18n` or `followText`. */
export function setTextSource(source: TextSource): void {
  textSource = source;
}

/** Asks this bundle's text source for the catalog again; nothing to do without one. */
export const refreshText = (): Promise<void> => textSource?.refresh?.() ?? Promise.resolve();

/** "a、b、c" in Chinese, "a, b, c" in English. */
export const joinList = (items: readonly string[]): string => items.join(t("kitText.listSeparator"));

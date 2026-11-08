import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { catalogIds, isPluralForms, lookup, META_SECTION, placeholdersOf, splitId, type Catalog } from "../shared/i18n";

/**
 * Test helper for a plugin's text (never bundled: no entry imports it). Copied to `<plugin>/server/i18n-audit.ts`.
 * - `auditCatalogs`: zh-CN and en have the same messages with the same placeholders, English has no CJK, every other
 *   built-in language is a usable subset.
 * - `findUntranslated`: CJK text left in string literals, template text or JSX text of the plugin's source. Comments and
 *   regular expressions are ignored; a line (or the line before it) with `i18n-ignore` is skipped, for text that is
 *   data rather than interface (patterns matched against agent output, sample input).
 * - `findMessageIds`: message ids the source names as string literals, to spot unused or unknown ones.
 * TypeScript (a dev dependency) is loaded on first use, so no plugin source imports a package a Git install lacks.
 */

type TypeScript = typeof import("typescript");
type Node = import("typescript").Node;
type SourceFile = import("typescript").SourceFile;
let loaded: TypeScript | undefined;
const typescript = (): TypeScript => (loaded ??= createRequire(import.meta.url)("typescript") as TypeScript);

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]/;
const IGNORE = "i18n-ignore";

export function auditCatalogs(catalogs: { zh: Catalog; en: Catalog; others?: { readonly [language: string]: Catalog } }): string[] {
  const problems: string[] = [];
  const shapes = (name: string, catalog: Catalog) => {
    for (const section of Object.keys(catalog)) {
      if (section === META_SECTION) continue;
      const entries = catalog[section];
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(section) || typeof entries !== "object" || entries === null || Array.isArray(entries)) {
        problems.push(`${name}: "${section}" is not a section of messages`);
        continue;
      }
      for (const key of Object.keys(entries)) {
        const id = `${section}.${key}`, message = (entries as Record<string, unknown>)[key];
        if (!splitId(id)) problems.push(`${name}: "${id}" is not a valid message id`);
        else if (typeof message === "string") { if (!message.trim()) problems.push(`${name}: ${id} is empty`); }
        else if (!isPluralForms(message)) problems.push(`${name}: ${id} must be text or plural forms with "other"`);
      }
    }
  };
  shapes("zh-CN", catalogs.zh);
  shapes("en", catalogs.en);
  const zhIds = catalogIds(catalogs.zh), enIds = catalogIds(catalogs.en);
  for (const id of zhIds) if (!enIds.includes(id)) problems.push(`en lacks ${id}`);
  for (const id of enIds) if (!zhIds.includes(id)) problems.push(`zh-CN lacks ${id}`);
  for (const id of zhIds) {
    const zh = lookup(catalogs.zh, id), en = lookup(catalogs.en, id);
    if (!zh || !en) continue;
    if (placeholdersOf(zh).join() !== placeholdersOf(en).join()) problems.push(`${id}: placeholders differ (zh-CN {${placeholdersOf(zh).join("}, {")}}, en {${placeholdersOf(en).join("}, {")}})`);
    const english = typeof en === "string" ? en : Object.values(en).join(" ");
    if (CJK.test(english)) problems.push(`en ${id} contains CJK text: ${english.slice(0, 60)}`);
  }
  for (const [language, catalog] of Object.entries(catalogs.others ?? {})) {
    shapes(language, catalog);
    for (const id of catalogIds(catalog)) {
      const reference = lookup(catalogs.en, id), message = lookup(catalog, id)!;
      if (!reference) problems.push(`${language}: ${id} is not a message of this plugin`);
      else if (placeholdersOf(message).some((name) => !placeholdersOf(reference).includes(name))) problems.push(`${language}: ${id} uses a placeholder English does not have`);
    }
  }
  return problems;
}

/** Source files under `root` in the given directories and top-level entry files, without tests and generated code. */
export function sourceFiles(root: string, options: { dirs?: readonly string[]; exclude?: RegExp } = {}): string[] {
  const files: string[] = [];
  const skip = options.exclude ?? /(^|\/)(node_modules|generated|test-fixtures|tests?|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), rel = relative(root, path);
      if (skip.test(rel)) continue;
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.[cm]?[jt]sx?$/.test(name)) files.push(path);
    }
  };
  for (const dir of options.dirs ?? ["client", "shared", "server"]) {
    try { if (statSync(join(root, dir)).isDirectory()) visit(join(root, dir)); } catch { /* the plugin has no such directory */ }
  }
  for (const name of readdirSync(root)) if (/^[\w.-]+\.(client|server)\.tsx?$|^index\.(client|server)\.tsx?$/.test(name)) files.push(join(root, name));
  return Array.from(new Set(files)).sort();
}

function parse(file: string): { source: SourceFile; lines: string[] } {
  const ts = typescript(), text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return { source, lines: text.split("\n") };
}

function walk(source: SourceFile, visit: (node: Node) => void) {
  const ts = typescript();
  const step = (node: Node) => { visit(node); ts.forEachChild(node, step); };
  step(source);
}

/** `{ file, line, text }` for every CJK literal the user could see. */
export function findUntranslated(root: string, files: readonly string[] = sourceFiles(root)): { file: string; line: number; text: string }[] {
  const ts = typescript(), found: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const { source, lines } = parse(file);
    walk(source, (node) => {
      const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
      if (!literal) return;
      const value = (node as import("typescript").LiteralLikeNode).text;
      if (!CJK.test(value)) return;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
      for (let at = Math.max(0, line - 1); at <= end; at++) if ((lines[at] ?? "").includes(IGNORE)) return;
      found.push({ file: relative(root, file), line: line + 1, text: value.trim().slice(0, 80) });
    });
  }
  return found;
}

/** Message ids named as string literals in the source (`"fold.stepsBefore"`), for the sections the catalog has. */
export function findMessageIds(root: string, catalog: Catalog, files: readonly string[] = sourceFiles(root)): Set<string> {
  const ts = typescript(), sections = new Set(Object.keys(catalog).filter((section) => section !== META_SECTION));
  const ids = new Set<string>();
  for (const file of files) {
    walk(parse(file).source, (node) => {
      if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
      const split = splitId(node.text);
      if (split && sections.has(split[0])) ids.add(node.text);
    });
  }
  return ids;
}

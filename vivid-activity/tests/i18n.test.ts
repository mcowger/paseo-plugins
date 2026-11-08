import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { auditCatalogs, findMessageIds, findUntranslated } from "../server/i18n-audit";
import { bindTranslator, catalogIds, checkCatalog, createTranslator, type Catalog } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import { formatReasoningMeta } from "../shared/presentation";
import { t } from "../shared/text";
import { instantText } from "../shared/clock";
import { foldTitle } from "../shared/fold";
import { looks } from "../shared/vivid-model";
import { noticeTextZh, readTaskNotice } from "../shared/notice";
import { readPiNotice } from "../shared/pi-notice";
import { childSummaryRow } from "../server/child-summary";

const root = fileURLToPath(new URL("../", import.meta.url));
const bindEnglish = () => bindTranslator(createTranslator("en", [en, kitEn]));
afterEach(() => bindTranslator(createTranslator("zh-CN", [zh, kitZh])));
// No generated message ids: every reference should be named in source. Add specific prefixes here if needed.
const dynamicPrefixes: string[] = [];

describe("Vivid Activity language catalogs", () => {
  it("has matching ids and placeholders in both built-in languages", () => {
    expect(auditCatalogs({ zh, en })).toEqual([]);
  });
  it("leaves only documented protocol/data CJK literals in source", () => {
    expect(findUntranslated(root)).toEqual([]);
  });
  it("uses every message and names only existing messages", () => {
    const ids = catalogIds(zh), used = findMessageIds(root, zh);
    expect(ids.filter((id) => !used.has(id) && !dynamicPrefixes.some((prefix) => id.startsWith(prefix)))).toEqual([]);
    expect([...used].filter((id) => !ids.includes(id))).toEqual([]);
  });
  it("renders English row words, folds and clocks", () => {
    bindEnglish();
    expect(looks.think.label).toBe("Thinking");
    expect(formatReasoningMeta(1, 1)).toBe("About 1 token");
    expect(t("ui.expandAllLinesCharacters", { count: 1, lines: 1, characters: 5000 })).toBe("Expand all (1 line, 5000 characters)");
    expect(foldTitle({ mode: "done", steps: 3, hidden: 3 })).toBe("3 steps");
    const now = new Date(2026, 9, 12, 20).getTime();
    const next = new Date(2026, 9, 13, 5).toISOString();
    expect(instantText(next, now)).toBe("Tomorrow 05:00 (in 9 hours)");
  });
  it("translates generated notices while preserving model-written subjects", () => {
    bindEnglish();
    const claude = JSON.parse(readFileSync(join(root, "test-fixtures/task-notices-0.11.1.json"), "utf8"));
    const source = claude.rows.find((entry: { name: string }) => entry.name === "agent-finished").row;
    const notice = readTaskNotice(source)!;
    expect(notice.subject).toBe("审查登录模块");
    expect(noticeTextZh(notice)).toContain('"审查登录模块"');
    expect(noticeTextZh(notice)).toMatch(/finished|completed/);
    const pi = JSON.parse(readFileSync(join(root, "test-fixtures/pi-notices-0.11.1.json"), "utf8"));
    const result = readPiNotice(pi.rows.find((entry: { name: string }) => entry.name === "bg-failed").row)!;
    expect(result.summary).toMatch(/failed/);
    expect(result.fields.some((field) => field.label === "Status")).toBe(true);
  });
  it("writes server-generated child rows in English", () => {
    bindEnglish();
    expect(childSummaryRow({ seqStart: 1, seqEnd: 1, item: { type: "reasoning", text: "User-owned thought" } as never })).toMatchObject({ t: "Thinking" });
  });
  it("uses a custom language with English fallback and reports invalid placeholders", () => {
    const checked = checkCatalog({ boot: { name: "활동", piNotice: "{unknown}" } }, en);
    expect(checked.invalid).toBe(1);
    expect(checked.issues[0]).toEqual({ code: "badPlaceholder", id: "boot.piNotice", detail: "{unknown}" });
    const custom = createTranslator("ko", [checked.catalog, en as Catalog, kitEn]);
    expect(custom.t("boot.name")).toBe("활동");
    expect(custom.t("boot.piNotice")).toBe("Pi notices");
  });
});

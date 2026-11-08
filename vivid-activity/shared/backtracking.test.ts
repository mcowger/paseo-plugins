import { describe, expect, it } from "vitest";
// @ts-expect-error -- prismjs does not declare default export for prism-core
import Prism from "prismjs/components/prism-core.min.js"; // the instance client/highlight.ts registers its grammars on
import "../client/highlight";
import { stripBlockComments } from "./codemode";
import { parseExaSearchResults } from "./exa";
import { parseReasoningMarkdown } from "./markdown";
import { stillRunning } from "./notice";
import {
  blockerParts,
  boundDetails,
  completionArchive,
  fetchedHeader,
  fetchFailure,
  nameAndStatus,
  oneLine,
  PI_NOTICE_LIMITS,
  quotedSubagent,
  readPiNotice,
  requestIdList,
  runHeader,
  scheduledRun,
  scheduleLine,
  tagBlocks,
  withoutParentAction,
} from "./pi-notice";
import { askContent, formatError, parseOpencodeSubagentOutput, parseSubAgentActionLog, relativeToRoot, stripLeadingCwdCd } from "./presentation";
import { splitAtLine, trimSpacesBeforeLineBreaks, trimTrailingSlashes } from "./text-scan";
import { mcpParts } from "./vivid-model";

/**
 * 0.6.0-local.2 (codex-vivid-F1 and the audit after it): every regex that ran on host data and backtracked
 * quadratically (or worse) is now a plain scan or a pattern without overlapping repeats. Each one here gets
 * - a time-bounded case at a size where the old regex took seconds (the old cost is in the 2026-10-12 fix report), and
 * - a comparison with the old regex on thousands of random strings built from the characters that matter to it.
 */
const BUDGET_MS = 100;
function took(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}
/** Deterministic random strings: `count` joins of up to `most` pieces from `pieces`, after an optional fixed `lead`. */
function strings(pieces: readonly string[], { count = 3000, most = 24, seed = 7, lead = [""] as readonly string[] } = {}): string[] {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const start = lead[Math.floor(random() * lead.length)]!;
    return start + Array.from({ length: Math.floor(random() * most) }, () => pieces[Math.floor(random() * pieces.length)]!).join("");
  });
}
const BREAKS = ["\n", "\r", "\u2028"];

describe("Pi notices: bounded before parsing, linear while parsing (codex-vivid-F1)", () => {
  it("squeezes 200 000 spaces in well under 100 ms, and reads like the old regex", () => {
    expect(took(() => oneLine(`a${" ".repeat(200_000)}z`))).toBeLessThan(BUDGET_MS);
    expect(took(() => oneLine(`${" ".repeat(200_000)}\n${" ".repeat(200_000)}x`))).toBeLessThan(BUDGET_MS);
    const old = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ").trim();
    for (const value of strings([" ", "\t", "\u00a0", "a", "中", ...BREAKS, "\r\n"])) expect(oneLine(value), JSON.stringify(value)).toBe(old(value));
  });

  it("finds tag blocks in 256 KB of unclosed tags in well under 100 ms, and the same blocks as the old regex", () => {
    const unclosed = "<status>".repeat(32 * 1024);
    expect(unclosed.length).toBe(256 * 1024);
    expect(took(() => expect(tagBlocks(unclosed, "status")).toEqual([]))).toBeLessThan(BUDGET_MS);
    expect(took(() => tagBlocks('<status a="1">'.repeat(18_725), "status"))).toBeLessThan(BUDGET_MS);
    expect(took(() => tagBlocks(`<status ${"a".repeat(256 * 1024)}`, "status"))).toBeLessThan(BUDGET_MS);
    expect(took(() => tagBlocks(`<status>${"</status ".repeat(28_000)}`, "status"))).toBeLessThan(BUDGET_MS);
    const old = (text: string) => Array.from(text.matchAll(/<status(?:\s[^<>]*)?>([\s\S]*?)<\/status\s*>/g), (match) => match[1]);
    const pieces = ["<status>", "</status>", "<status ", "<status\t", "</status ", "</status\n>", "<statuses>", "</statusx>", ">", "<", "/", "a", " ", "\n", 'x="1"'];
    for (const text of strings(pieces)) expect(tagBlocks(text, "status"), JSON.stringify(text)).toEqual(old(text));
    for (const text of strings(pieces, { seed: 11 })) expect(tagBlocks(text, "status", 1)[0], JSON.stringify(text)).toBe(old(text)[0]);
  });

  it("reads the completion archive line in well under 100 ms, as the old regex did", () => {
    expect(took(() => completionArchive(`Completion archive: ${" ".repeat(200_000)}x`))).toBeLessThan(BUDGET_MS);
    const old = (text: string) => /Completion archive: (.+?)\.?\s*$/m.exec(text)?.[1];
    for (const text of strings(["Completion archive: ", "a", ".", " ", "\t", "/", ...BREAKS])) expect(completionArchive(text), JSON.stringify(text)).toBe(old(text));
  });

  it("reads pi-subagents' header, schedule, child-run, blocker and parent-action lines in linear time, as the old regexes did", () => {
    const sized = 200_000;
    // Each input took the old regex from a few hundred milliseconds to many seconds (attack-before.json in the report).
    expect(took(() => runHeader(`Background task failed: **${"*".repeat(sized)}\r`))).toBeLessThan(BUDGET_MS);
    expect(took(() => scheduleLine(`Scheduled run from **a** (schedule ${"a** (schedule ".repeat(sized / 14)}//`))).toBeLessThan(BUDGET_MS);
    expect(took(() => scheduledRun(`${" — scheduled run from a (schedule  ".repeat(sized / 35)}—-`))).toBeLessThan(BUDGET_MS);
    expect(took(() => nameAndStatus(`${" (\u0000".repeat(sized / 3)}\n\u0001\n`))).toBeLessThan(BUDGET_MS);
    expect(took(() => blockerParts(`${"- a: \u0001".repeat(sized / 6)}ut`))).toBeLessThan(BUDGET_MS);
    expect(took(() => withoutParentAction(`\n\nParent action: ${"\r".repeat(sized)}\no`))).toBeLessThan(BUDGET_MS);

    const RUN_HEADER = /^(Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*(.*)$/;
    const heads = ["Background task failed: **", "Detached foreground task completed: **", "Background task paused: *", ""];
    for (const line of strings(["**", "*", "a", " ", ...BREAKS], { lead: heads })) {
      const match = RUN_HEADER.exec(line);
      expect(runHeader(line), JSON.stringify(line)).toEqual(match ? [match[1], match[2], match[3], match[4]] : null);
    }
    const SCHEDULE_LINE = /^Scheduled run from \*\*(.+?)\*\* \(schedule (.+?)\)\.$/;
    for (const line of strings(["** (schedule ", ").", ")", ".", "**", "a", " (", ...BREAKS], { lead: ["Scheduled run from **", "Scheduled run from *", ""] })) {
      const match = SCHEDULE_LINE.exec(line);
      expect(scheduleLine(line), JSON.stringify(line)).toEqual(match ? [match[1], match[2]] : null);
    }
    const SCHEDULED = / — scheduled run from (.+?) \(schedule (.+?)\)$/;
    for (const header of strings([" — scheduled run from ", " (schedule ", ")", "(", "a", " ", "—", ...BREAKS])) {
      const match = SCHEDULED.exec(header);
      expect(scheduledRun(header), JSON.stringify(header)).toEqual(match ? { index: match.index, name: match[1], id: match[2] } : null);
    }
    const STATUS = /^(.*?)(?: \(([^)]*)\))?$/;
    for (const value of strings(["a", " ", "(", ")", " (", "x=1", "completed", ...BREAKS])) {
      const match = STATUS.exec(value);
      expect(nameAndStatus(value), JSON.stringify(value)).toEqual(match ? [match[1], match[2]] : null);
    }
    const BLOCKER = /^- (.+?): (.+) \((addressed|unaddressed|stalemate)\)$/;
    for (const line of strings(["a", ": ", ":", " ", " (addressed)", " (unaddressed)", " (stalemate)", "(", ")", ...BREAKS], { lead: ["- ", "-", ""] })) {
      const match = BLOCKER.exec(line);
      expect(blockerParts(line), JSON.stringify(line)).toEqual(match ? [match[1], match[2], match[3]] : null);
    }
    for (const text of strings(["\n\nParent action: ", "\n", " ", "\t", "\r", "a", "\u2028"])) {
      expect(withoutParentAction(text), JSON.stringify(text)).toBe(text.replace(/\n\nParent action: [^\n]*\s*$/, ""));
    }
  });

  it("reads gotgenes, supervisor and web notices in linear time, as the old regexes did", () => {
    expect(took(() => quotedSubagent(`${'Subagent "\u0001'.repeat(20_000)}中`, " sent an update"))).toBeLessThan(BUDGET_MS);
    expect(took(() => requestIdList(`${"REQUEST IDS: .".repeat(15_000)}- `))).toBeLessThan(BUDGET_MS);
    expect(took(() => fetchedHeader(`${"Content fetched for 0/0 URLs [ ".repeat(7_000)}\ro`))).toBeLessThan(BUDGET_MS);
    expect(took(() => fetchFailure(`${"Content fetch failed [a".repeat(9_000)}a"`))).toBeLessThan(BUDGET_MS);

    for (const [ending, old] of [[" sent an update", /Subagent "([\s\S]*)" sent an update/], [" left work behind", /Subagent "([\s\S]*)" left work behind/]] as const) {
      for (const summary of strings(['Subagent "', `"${ending}`, '"', "a", " ", "\n"])) expect(quotedSubagent(summary, ending), JSON.stringify(summary)).toBe(old.exec(summary)?.[1]);
    }
    for (const text of strings(["request IDs: ", "REQUEST ids: ", "a", ".", " ", ",", "\n", "\r"])) {
      expect(requestIdList(text), JSON.stringify(text)).toBe(/request IDs: ([^\n]+?)\.(?:\s|$)/i.exec(text)?.[1]);
    }
    for (const text of strings(["Content fetched for ", "1", "23", "/", " URLs [", "]", "a", " ", "\n"])) {
      const match = /Content fetched for (\d+)\/(\d+) URLs \[([^\]]*)\]/.exec(text);
      expect(fetchedHeader(text), JSON.stringify(text)).toEqual(match ? [match[1], match[2], match[3]] : null);
    }
    for (const text of strings(["Content fetch failed [", "]", ":", " ", "a", "\n", "["])) {
      const match = /Content fetch failed \[([^\]]*)\]:\s*([\s\S]*)$/.exec(text);
      expect(fetchFailure(text), JSON.stringify(text)).toEqual(match ? [match[1], match[2]] : null);
    }
  });

  it("bounds details before any parser sees them: strings, total size, entries, values and depth", () => {
    const limits = PI_NOTICE_LIMITS;
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let level = 0; level < 100_000; level++) deep = { next: deep };
    const huge = { name: `a${" ".repeat(200_000)}z`, runs: Array.from({ length: 1_000_000 }, (_, index) => ({ agent: `agent-${index}`, status: "completed" })), deep, ["k".repeat(10_000)]: 1 };
    let copy: unknown;
    expect(took(() => (copy = boundDetails(huge)))).toBeLessThan(BUDGET_MS);
    const bounded = copy as { name: string; runs: unknown[]; deep: unknown };
    expect(bounded.name).toHaveLength(limits.string);
    expect(bounded.runs.length).toBeLessThanOrEqual(limits.entries);
    expect(Object.keys(bounded)).not.toContain("k".repeat(10_000));
    let depth = 0;
    for (let node = bounded.deep as Record<string, unknown> | undefined; node && typeof node === "object"; node = node.next as Record<string, unknown> | undefined) depth++;
    expect(depth).toBeLessThanOrEqual(limits.depth);
    // Strings and keys together stay within `chars`; the JSON a body could show stays small.
    const many = { list: Array.from({ length: 150 }, () => "x".repeat(limits.string)) };
    const strings_ = (boundDetails(many) as { list: string[] }).list;
    expect(strings_.reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(limits.chars);
    expect(JSON.stringify(boundDetails(huge)).length).toBeLessThan(4 * limits.chars);
    // Plain values only; an own `__proto__` key never becomes the copy's prototype.
    const tricky = boundDetails(JSON.parse('{"__proto__": {"status": "failed"}, "ok": [1, true, null, "s"]}')) as Record<string, unknown>;
    expect(tricky.status).toBeUndefined();
    expect(tricky).toEqual({ ok: [1, true, null, "s"] });
    expect(boundDetails({ get bad() { throw new Error("no"); } })).toBeUndefined();
  });

  const row = (customType: string, text: string, details?: unknown) => ({
    name: customType,
    status: "completed",
    detail: { type: "plain_text", text },
    metadata: { synthetic: true, customType, ...(details === undefined ? {} : { details }) },
  });

  it("parses only the first PI_NOTICE_LIMITS.text characters of text and the bounded copy of details", () => {
    const pad = "x".repeat(PI_NOTICE_LIMITS.text);
    expect(JSON.stringify(readPiNotice(row("made-up-type", `<a>early</a><b>value</b>${pad}`)))).toContain("early");
    expect(JSON.stringify(readPiNotice(row("made-up-type", `${pad}<a>late</a><b>value</b>`)))).not.toContain("late");
    const runs = Array.from({ length: 1000 }, (_, index) => ({ agent: `worker-${index}`, status: "failed" }));
    const grouped = JSON.stringify(readPiNotice(row("subagent-notify", "Background tasks completed (1000):", { runs })));
    expect(grouped).toContain(`worker-${PI_NOTICE_LIMITS.entries - 1}`);
    expect(grouped).not.toContain(`worker-${PI_NOTICE_LIMITS.entries}`);
  });

  it("parses the reviewer's notices end to end in well under 100 ms (200 000 spaces in details, 256 KB of unclosed tags)", () => {
    // codex-vivid-F1's reproduction: a background-task notice whose task name is 200 000 spaces between two letters.
    const spaced = row("background-task-notification", "<background-task-notification><status>failed</status></background-task-notification>", { id: "t1", name: `a${" ".repeat(200_000)}z`, status: "failed" });
    let notice: ReturnType<typeof readPiNotice> = null;
    expect(took(() => (notice = readPiNotice(spaced)))).toBeLessThan(BUDGET_MS);
    expect(notice).toMatchObject({ customType: "background-task-notification", state: "failed" });
    expect(notice!.summary.length).toBeLessThanOrEqual(200);
    for (const customType of ["background-task-notification", "subagent-notification", "subagent-update", "goal-contract", "made-up-type"]) {
      expect(took(() => readPiNotice(row(customType, "<status>".repeat(32 * 1024))))).toBeLessThan(BUDGET_MS);
      expect(took(() => readPiNotice(row(customType, `<summary>${" ".repeat(200_000)}x\r</summary>`)))).toBeLessThan(BUDGET_MS);
    }
    for (const [customType, text] of [
      ["subagent-notify", `Background task failed: **${"*".repeat(200_000)}\r`],
      ["subagent-notify", `Background tasks completed (2):\n\n1. ${" — scheduled run from a (schedule  ".repeat(6_000)}—-`],
      ["subagent-wait-subscription", `Wait subscription t fired for run r: completed. Completion archive: ${" ".repeat(200_000)}x`],
      ["subagent-supervisor-unanswered", `${"REQUEST IDS: .".repeat(15_000)}- `],
      ["web-search-content-ready", `${"Content fetched for 0/0 URLs [ ".repeat(7_000)}\ro`],
    ] as const) {
      expect(took(() => readPiNotice(row(customType, text))), customType).toBeLessThan(BUDGET_MS);
    }
  });
});

describe("Claude Code notices (codex-vivid-F1 audit)", () => {
  it("reads 「is still running after …」 in linear time, as the old regex did", () => {
    expect(took(() => stillRunning(`is still running after 5m${", with no new output for ".repeat(8_000)}\n`))).toBeLessThan(BUDGET_MS);
    const old = /^is still running after (.+?), with no new output for (.+?)\.?$/i;
    const pieces = [", with no new output for ", ", WITH NO NEW OUTPUT FOR ", "5m", ".", ",", " ", "a", ...BREAKS];
    for (const tail of strings(pieces, { lead: ["is still running after ", "IS STILL RUNNING AFTER ", "is still running"] })) {
      const match = old.exec(tail);
      expect(stillRunning(tail), JSON.stringify(tail)).toEqual(match ? [match[1], match[2]] : null);
    }
  });
});

describe("tool rows and details (codex-vivid-F1 audit)", () => {
  it("trims trailing slashes and splits at a line of its own in linear time, as the old regexes did", () => {
    expect(took(() => relativeToRoot("/x/y", `${"/".repeat(200_000)}a`))).toBeLessThan(BUDGET_MS);
    expect(took(() => stripLeadingCwdCd(`cd ${"/".repeat(200_000)}a && ls`, `${"/".repeat(200_000)}b`))).toBeLessThan(BUDGET_MS);
    expect(took(() => askContent({ type: "plain_text", text: `${"\n".repeat(100_000)}x` }))).toBeLessThan(BUDGET_MS);
    // (Exa's text is trimmed first, so the blank run sits between two results.)
    expect(took(() => parseExaSearchResults(`Title: a${"\n".repeat(200_000)}x`))).toBeLessThan(BUDGET_MS);
    expect(took(() => formatError(`${"\t".repeat(200_000)}.\r`))).toBeLessThan(BUDGET_MS);

    for (const value of strings(["/", "a", "\\", " ", "\n"])) expect(trimTrailingSlashes(value)).toBe(value.replace(/\/+$/, ""));
    for (const value of strings([" ", "\t", "\n", "a", "\r"])) expect(trimSpacesBeforeLineBreaks(value)).toBe(value.replace(/[ \t]+\n/g, "\n"));
    for (const text of strings(["\n", " ", "\t", "Answers:", "Answers", ":", "a", "\r", "\u2028"])) {
      expect(splitAtLine(text, "Answers:"), JSON.stringify(text)).toEqual(text.split(/\n\s*Answers:\s*\n/));
    }
    const titled = (text: string) => (end: number, spacesEnd: number) => end === spacesEnd && text.startsWith("Title:", end) && /\s/.test(text[end + 6] ?? "");
    for (const text of strings(["\n", " ", "---", "-", "Title:", "Title: x", "a", "\t"])) {
      expect(splitAtLine(text, "---", titled(text)), JSON.stringify(text)).toEqual(text.split(/\n\s*---\s*\n(?=Title:\s)/));
    }
    // Exa's own reader still splits its blocks where the old regex did.
    const results = "Title: One\nURL: https://a.example\n\n---\n\nTitle: Two\nURL: https://b.example\n---\nTitle: Three\n";
    expect(parseExaSearchResults(results).map((result) => result.title)).toEqual(["One", "Two", "Three"]);
  });

  it("reads questions and answers, the sub-agent action log and MCP names in linear time, as the old regexes did", () => {
    // askContent reads the first MAX_FORMAT_CHARS (100 000) characters; a \r or U+2028 inside the line made the old ones backtrack.
    expect(took(() => askContent({ type: "plain_text", text: `a:${" ".repeat(90_000)}x\ry` }))).toBeLessThan(BUDGET_MS);
    expect(took(() => askContent({ type: "plain_text", text: `q\nAnswers:\na:${" ".repeat(90_000)}x\u2028y` }))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseSubAgentActionLog(`[a]${" ".repeat(200_000)}a\u2028b`))).toBeLessThan(BUDGET_MS);
    expect(took(() => mcpParts(`mcp__${"a__".repeat(70_000)}\nx`))).toBeLessThan(BUDGET_MS);

    const QUESTION = /^([^:：]{1,80})[:：]\s*(.+)$/;
    const ANSWER = /^([^:]{1,80}):\s*(.*)$/;
    // One line each (askContent splits at \n); a \r or U+2028 inside the line is what made the old patterns backtrack.
    for (const line of strings(["a", ":", "：", " ", "\t", "\u00a0", "x", "\r", "\u2028"], { lead: ["Header:", "a", ""] })) {
      const first = line.trim();
      if (!first) continue;
      const question = askContent({ type: "plain_text", text: first }).questions[0];
      const match = QUESTION.exec(first);
      expect(question, JSON.stringify(first)).toMatchObject(match ? { header: match[1], question: match[2] } : { question: first });
      const answer = askContent({ type: "plain_text", text: `q\nAnswers:\n${first}` }).answers[0];
      const pair = ANSWER.exec(first);
      expect(answer, JSON.stringify(first)).toEqual(pair ? { question: pair[1], answer: pair[2] } : { question: null, answer: first });
    }
    const ACTION = /^\[([^\]]+)\]\s*(.*)$/;
    for (const line of strings(["[", "]", "a", " ", "\t", "\u2028", "\r", "x"], { lead: ["[a]", "[", ""] })) {
      const match = line.trim().match(ACTION);
      const expected = match?.[1]?.trim() ? [{ index: 0, toolName: match[1].trim(), ...(match[2]?.trim() ? { summary: match[2].trim() } : {}) }] : [];
      expect(parseSubAgentActionLog(line.replace(/\n/g, " ")), JSON.stringify(line)).toEqual(expected);
    }
    for (const name of strings(["mcp__", "__", "_", "a", " ", ...BREAKS], { lead: ["mcp__", "mcp_", ""] })) {
      const match = /^mcp__(.+?)__(.+)$/.exec(name.trim());
      expect(mcpParts(name), JSON.stringify(name)).toEqual(match ? { server: match[1], tool: match[2] } : null);
    }
  });

  it("reads OpenCode's sub-agent envelope and background notice in linear time, as the old regexes did", () => {
    expect(took(() => parseOpencodeSubagentOutput(`<subagent${" ".repeat(200_000)}u"`))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseOpencodeSubagentOutput(`${"<subagent a".repeat(20_000)}`))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseOpencodeSubagentOutput(`working in the background(sessionID:${"\n".repeat(200_000)}k\r`))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseOpencodeSubagentOutput(`${"working in the background (sessionID:a".repeat(5_000)}`))).toBeLessThan(BUDGET_MS);

    const OPEN = /<subagent\s+([^>]*?)>/i;
    const BACKGROUND = /working in the background\s*\(sessionID:\s*([^)]+)\)/i;
    const pieces = ["<subagent", "<SUBAGENT", " ", "\n", ">", "a", 'state="done"', "</subagent>", "working in the background", "(sessionID:", " ses_1", ")"];
    for (const raw of strings(pieces, { seed: 3 })) {
      const text = raw.trim();
      if (!text) continue;
      const parsed = parseOpencodeSubagentOutput(text);
      const open = OPEN.exec(text);
      const background = BACKGROUND.exec(text);
      if (open?.[1] && /state="done"/i.test(open[1])) expect(parsed?.status, JSON.stringify(text)).toBe("done");
      else if (!open?.[1] && background?.[1]) expect(parsed, JSON.stringify(text)).toMatchObject({ sessionID: background[1].trim(), status: "running", isBackgroundNotice: true });
      else if (!open?.[1]) expect(parsed?.isBackgroundNotice, JSON.stringify(text)).toBeUndefined();
    }
  });

  it("strips block comments from Code Mode scripts in linear time, as the old regex did", () => {
    expect(took(() => stripBlockComments("/*a".repeat(70_000)))).toBeLessThan(BUDGET_MS);
    for (const code of strings(["/*", "*/", "/", "*", "a", "\n", " "])) expect(stripBlockComments(code), JSON.stringify(code)).toBe(code.replace(/\/\*[\s\S]*?\*\//g, " "));
  });

  it("reads markdown headings and list items in reasoning in linear time, as the old regexes did", () => {
    for (const line of [`# ${" ".repeat(200_000)}x\r`, `- ${"\t".repeat(200_000)}x\u2028y`, `1. ${" ".repeat(200_000)}x\r`]) {
      expect(took(() => parseReasoningMarkdown(line))).toBeLessThan(BUDGET_MS);
    }
    // One line at a time (no \n): the block the old patterns gave.
    const reference = (line: string) => {
      const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
      if (heading) return { type: "heading", text: heading[1] };
      const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (unordered) return { type: "unordered", text: unordered[1] };
      const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
      if (ordered) return { type: "ordered", marker: `${ordered[1]}.`, text: ordered[2] };
      return null;
    };
    for (const line of strings(["#", "-", "*", "+", "1", "1.", "2)", " ", "\t", "\u00a0", "a", "\r", "\u2028"], { most: 12 })) {
      if (!line.trim() || line.trim().startsWith("```") || line.includes("\n")) continue;
      const [block] = parseReasoningMarkdown(line);
      const expected = reference(line);
      if (expected) expect(block, JSON.stringify(line)).toEqual(expected);
      else expect(block!.type, JSON.stringify(line)).toMatch(/^(quote|paragraph)$/);
    }
  });

  it("highlights hostile shell commands in linear time (bash strings and ${…})", () => {
    const grammar = Prism.languages.bash as { string: { pattern: RegExp }; variable: RegExp };
    const string = new RegExp(grammar.string.pattern.source, grammar.string.pattern.flags);
    expect(took(() => string.exec(`"${'\\"'.repeat(100_000)}`))).toBeLessThan(BUDGET_MS);
    // `${…}` scans at most 256 characters from each `$`: linear, at most 256 steps per start.
    expect(took(() => grammar.variable.exec("${".repeat(25_000)))).toBeLessThan(BUDGET_MS);
    // Still the same strings and variables in ordinary commands.
    const tokens = (command: string) => Prism.tokenize(command, Prism.languages.bash).filter((token: unknown) => typeof token !== "string").map((token: { type: string; content: unknown }) => [token.type, String(token.content)]);
    expect(tokens('echo "a \\"b\\" $HOME" \'c\' ${PATH:-/bin} "x"')).toEqual([
      ["builtin", "echo"],
      ["string", '"a \\"b\\" $HOME"'],
      ["string", "'c'"],
      ["variable", "${PATH:-/bin}"],
      ["string", '"x"'],
    ]);
  });
});

describe("few characters, many lines (codex-vivid-F4)", () => {
  const pi = (customType: string, text: string) => ({ name: customType, status: "completed", detail: { type: "plain_text", text }, metadata: { synthetic: true, customType } });

  it("reads a Pi notice of 64 000 blank lines (64 KB) in well under 100 ms, the same as a short one", () => {
    // Codex's input: below the 64 KiB text bound; `rows.shift()` per blank line took 5.6 s.
    const text = `Background task failed: **worker**\n${"\n".repeat(64_000)}result`;
    expect(text.length).toBeLessThan(PI_NOTICE_LIMITS.text);
    let notice: ReturnType<typeof readPiNotice> = null;
    expect(took(() => (notice = readPiNotice(pi("subagent-notify", text))))).toBeLessThan(BUDGET_MS);
    expect(notice).toEqual(readPiNotice(pi("subagent-notify", "Background task failed: **worker**\n\nresult")));
    expect(notice).toMatchObject({ state: "failed", body: "result" });
  });

  it("skips such a run wherever a run may hold one: after the receipt, the schedule or the errors, before the name or the metadata", () => {
    // Each place had its own `rows.shift()` loop; each took 5.5 s on 64 000 blank lines.
    const head = "Background task failed: **worker**\n";
    const places = [
      (gap: string) => `${head}Workflow receipt: r1\n${gap}result`,
      (gap: string) => `${head}Scheduled run from **nightly** (schedule s1).\n${gap}result`,
      (gap: string) => `${head}Error: boom\n${gap}result`,
      (gap: string) => `${head}Error: boom\n${gap}worker:\nresult`,
      (gap: string) => `${head}result\n${gap}Session: s`,
    ];
    for (const place of places) {
      let notice: ReturnType<typeof readPiNotice> = null;
      const text = place("\n".repeat(64_000));
      expect(took(() => (notice = readPiNotice(pi("subagent-notify", text)))), text.slice(0, 80)).toBeLessThan(BUDGET_MS);
      expect(notice, text.slice(0, 80)).toEqual(readPiNotice(pi("subagent-notify", place("\n\n"))));
      expect(notice).toMatchObject({ body: "result" });
    }
  });

  it("parses every kind of text with tens of thousands of short lines in well under 100 ms", () => {
    const cases: Array<[string, () => unknown]> = [
      ["Pi run errors", () => readPiNotice(pi("subagent-notify", `Background task failed: **w**\n${"Error: boom\n".repeat(5_800)}`))],
      ["Pi run metadata", () => readPiNotice(pi("subagent-notify", `Background task failed: **w**\nout\n${"Session: s\n".repeat(5_800)}`))],
      ["Pi grouped runs", () => readPiNotice(pi("subagent-notify", `Background tasks completed (6000):\n${Array.from({ length: 6_000 }, (_, i) => `\n${i + 1}. a\nx`).join("")}`))],
      ["Pi blockers", () => readPiNotice(pi("subagent-notify", `Background task failed: **w**\nWatchdog blockers:\n${"- a: b (addressed)\n".repeat(3_300)}`))],
      ["Pi child outputs", () => readPiNotice(pi("subagent-notify", `Background task failed: **w**\nChild outputs:\n${"- a: b\n".repeat(9_000)}`))],
      ["Pi unknown type", () => readPiNotice(pi("made-up-type", "a\n".repeat(32_000)))],
      ["Pi background task", () => readPiNotice(pi("background-task-notification", `<background-task-notification>${"\n".repeat(64_000)}<status>failed</status></background-task-notification>`))],
      ["reasoning markdown", () => parseReasoningMarkdown("\n".repeat(64_000))],
      ["reasoning lists", () => parseReasoningMarkdown("- a\n".repeat(16_000))],
      ["questions", () => askContent({ type: "plain_text", text: "q\n\n".repeat(21_000) })],
      ["answers", () => askContent({ type: "plain_text", text: `q\nAnswers:\n${"a: b\n".repeat(12_000)}` })],
      ["sub-agent action log", () => parseSubAgentActionLog("[Read] a\n".repeat(7_000))],
      ["error details", () => formatError("x\n\n\n".repeat(16_000))],
      ["Exa results", () => parseExaSearchResults(`Title: a\n${"\n---\nTitle: b\nURL: c\n".repeat(2_500)}`)],
    ];
    for (const [name, run] of cases) expect(took(run), name).toBeLessThan(BUDGET_MS);
  });
});

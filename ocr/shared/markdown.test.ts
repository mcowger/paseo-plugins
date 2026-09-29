import { describe, expect, it } from "vitest";
import { parseFindingMarkdown, parseInlineFindingMarkdown } from "./markdown";

describe("parseInlineFindingMarkdown", () => {
  it("splits bold, italic, and inline code", () => {
    expect(parseInlineFindingMarkdown("Use **bold**, *italics*, and `code`.")).toEqual([
      { type: "text", text: "Use " },
      { type: "bold", text: "bold" },
      { type: "text", text: ", " },
      { type: "italic", text: "italics" },
      { type: "text", text: ", and " },
      { type: "code", text: "code" },
      { type: "text", text: "." },
    ]);
  });

  it("returns plain text untouched", () => {
    expect(parseInlineFindingMarkdown("no formatting here")).toEqual([
      { type: "text", text: "no formatting here" },
    ]);
  });
});

describe("parseFindingMarkdown", () => {
  it("parses headings, lists, quotes, and fenced code", () => {
    expect(
      parseFindingMarkdown(
        "## Why\n\n- first\n- second\n\n1. step one\n\n> note\n\n```ts\nconst a = 1;\n```\n\ndone",
      ),
    ).toEqual([
      { type: "heading", text: "Why" },
      { type: "spacer" },
      { type: "unordered", text: "first" },
      { type: "unordered", text: "second" },
      { type: "spacer" },
      { type: "ordered", marker: "1.", text: "step one" },
      { type: "spacer" },
      { type: "quote", text: "note" },
      { type: "spacer" },
      { type: "code", language: "ts", text: "const a = 1;" },
      { type: "spacer" },
      { type: "paragraph", text: "done" },
    ]);
  });

  it("keeps unclosed fences as code instead of dropping them", () => {
    expect(parseFindingMarkdown('before\n```json\n{\n  "ok": true')).toEqual([
      { type: "paragraph", text: "before" },
      { type: "code", language: "json", text: '{\n  "ok": true' },
    ]);
  });
});

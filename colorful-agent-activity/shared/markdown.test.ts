import { describe, expect, it } from "vitest";
import { parseInlineMarkdown, parseReasoningMarkdown } from "./markdown";

describe("reasoning markdown", () => {
  it("renders inline bold, italic, and code tokens as distinct parts", () => {
    expect(parseInlineMarkdown("Use **bold**, *italics*, and `code`.")).toEqual([
      { type: "text", text: "Use " },
      { type: "bold", text: "bold" },
      { type: "text", text: ", " },
      { type: "italic", text: "italics" },
      { type: "text", text: ", and " },
      { type: "code", text: "code" },
      { type: "text", text: "." },
    ]);
  });

  it("preserves all reasoning-display block types", () => {
    expect(
      parseReasoningMarkdown(
        "# Heading\n\n- **one**\n2) `two`\n> quoted\n\n```ts\nconst value = 1;\n```",
      ),
    ).toEqual([
      { type: "heading", text: "# Heading".slice(2) },
      { type: "spacer" },
      { type: "unordered", text: "**one**" },
      { type: "ordered", marker: "2.", text: "`two`" },
      { type: "quote", text: "quoted" },
      { type: "spacer" },
      { type: "code", language: "ts", text: "const value = 1;" },
    ]);
  });

  it("keeps an unclosed fenced block together", () => {
    expect(parseReasoningMarkdown("before\n```json\n{\n  \"ok\": true\n")).toEqual([
      { type: "paragraph", text: "before" },
      { type: "code", language: "json", text: "{\n  \"ok\": true\n" },
    ]);
  });
});

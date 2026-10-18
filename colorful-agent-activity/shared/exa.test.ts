import { describe, expect, it } from "vitest";
import {
  exaHighlightPreview,
  exaOutputText,
  exaToolKind,
  exaToolSummary,
  parseExaSearchResults,
} from "./exa";

describe("Exa tool presentation", () => {
  it("recognizes namespaced Exa tools", () => {
    expect(exaToolKind("mcp__exa__web_search_exa")).toBe("search");
    expect(exaToolKind("exa_web_fetch_exa")).toBe("fetch");
    expect(exaToolKind("exa_agent_run")).toBe("agent");
    expect(exaToolKind("mcp__github__search_code")).toBeNull();
  });

  it("summarizes search queries", () => {
    expect(exaToolSummary("search", { query: "find Paseo plugin docs" })).toBe(
      "find Paseo plugin docs",
    );
  });

  it("falls back to MCP text when structured content has no text", () => {
    expect(
      exaOutputText({
        structuredContent: { results: [{ title: "Structured result" }] },
        content: [{ type: "text", text: "Fallback text" }],
      }),
    ).toBe("Fallback text");
  });

  it("parses Pi's text envelope into search result cards", () => {
    // What the MCP server actually returns: formatted text, carried as a string.
    const output = {
      content: [
        "Title: eval() function is not compatible with hermes in iOS",
        "URL: https://github.com/facebook/hermes/issues/785",
        "Published: 2022-07-22T09:01:19.000Z",
        "Author: Yandamuri",
        "Highlights:",
        "### Description",
        "",
        "---",
        "",
        "Title: ES Classes support",
        "URL: https://github.com/facebook/hermes/issues/685",
      ].join("\n"),
      details: { server: "exa", tool: "web_search_exa" },
    };
    expect(parseExaSearchResults(output)).toEqual([
      {
        title: "eval() function is not compatible with hermes in iOS",
        url: "https://github.com/facebook/hermes/issues/785",
        published: "2022-07-22T09:01:19.000Z",
        author: "Yandamuri",
        // Markdown chrome is stripped: a heading marker is not worth a row's line.
        highlights: "Description",
      },
      {
        title: "ES Classes support",
        url: "https://github.com/facebook/hermes/issues/685",
      },
    ]);
  });

  it("keeps a highlight to one short line", () => {
    // A scraped page highlight is markdown from someone else's prose. The row points at the
    // page; it does not reprint it.
    const body = [
      "### Description",
      "",
      "I have `hermes` enabled in my **iOS** project and trying to execute the snippet below.",
      "",
      "[Image: Simulator Screenshot | https://example.com/shot.png]",
      "",
      "...",
      "",
      "**@someone** commented · Jul 22, 2022",
      "",
      "> quoted reply that goes on and on for a very long time indeed, well past any",
      "reasonable preview length, because pages are long and rows are not.",
    ].join("\n");
    const preview = exaHighlightPreview(body);
    expect(preview).toBe(
      "Description I have hermes enabled in my iOS project and trying to execute the snippet below. " +
        "@someone commented · Jul 22, 2022 quoted reply that goes on and on for a very long time indeed, well past…",
    );
    expect(exaHighlightPreview(undefined)).toBeUndefined();
    expect(exaHighlightPreview("...")).toBeUndefined();
  });

  it("parses MCP text output into search result cards", () => {
    const output = {
      content: [
        {
          type: "text",
          text: [
            "Title: Plugin docs",
            "URL: https://paseo.sh/docs/plugins",
            "Published: 2026-08-28",
            "Author: N/A",
            "Highlights:",
            "The plugin guide.",
            "",
            "---",
            "",
            "Title: API reference",
            "URL: https://paseo.sh/docs/plugins/v0.8/reference",
            "Highlights:",
            "The API reference.",
          ].join("\n"),
        },
      ],
    };
    expect(exaOutputText(output)).toContain("Title: Plugin docs");
    expect(parseExaSearchResults(output)).toEqual([
      {
        title: "Plugin docs",
        url: "https://paseo.sh/docs/plugins",
        published: "2026-08-28",
        author: "N/A",
        highlights: "The plugin guide.",
      },
      {
        title: "API reference",
        url: "https://paseo.sh/docs/plugins/v0.8/reference",
        highlights: "The API reference.",
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
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

import { describe, expect, it } from "vitest";
import { isOmpFindTool, parseOmpFindResult } from "./omp-find";

describe("OMP find presentation", () => {
  it("recognizes find tool names with OMP namespaces", () => {
    expect(isOmpFindTool("find")).toBe(true);
    expect(isOmpFindTool("functions.find")).toBe(true);
    expect(isOmpFindTool("tools.find")).toBe(true);
    expect(isOmpFindTool("grep")).toBe(false);
  });

  it("parses query, scope, keywords, hit snippets, and summary from the result envelope", () => {
    const result = parseOmpFindResult(
      {
        query: "Find provider configuration",
        grep_keywords: ["baseUrl", "contextWindow", "enabledModels"],
        path: "dot_omp",
      },
      {
        content: [{ type: "text", text: "2 hit(s) for provider configuration" }],
        details: {
          query: "Find provider configuration",
          scopePath: "dot_omp/",
          hits: [
            {
              rel: "dot_omp/private_agent/models.yml",
              contentScore: 0.82,
              linesSeen: 69,
              ranges: [{ start: 1, end: 69, snippet: "providers:" }],
            },
          ],
          listed: 2,
          judged: 2,
          filesRead: 2,
          elapsedMs: 6276,
        },
      },
    );

    expect(result).toEqual({
      query: "Find provider configuration",
      keywords: ["baseUrl", "contextWindow", "enabledModels"],
      path: "dot_omp",
      hits: [
        {
          path: "dot_omp/private_agent/models.yml",
          score: 0.82,
          ranges: [{ start: 1, end: 69, snippet: "providers:" }],
        },
      ],
      listed: 2,
      judged: 2,
      filesRead: 2,
    });
  });

  it("handles an empty result without inventing hits", () => {
    expect(parseOmpFindResult({ query: "nothing", grep_keywords: [] }, { details: { hits: [] } })).toEqual({
      query: "nothing",
      keywords: [],
      path: undefined,
      hits: [],
    });
  });
});

import { describe, expect, it } from "vitest";
import { isOmpEvalTool, isOmpWebSearchTool, parseOmpEval, parseOmpWebSearch } from "./omp-tools";

describe("OMP eval and web_search presentation", () => {
  it("recognizes native OMP tool names without claiming unrelated providers", () => {
    expect(isOmpEvalTool("eval")).toBe(true);
    expect(isOmpEvalTool("functions.eval")).toBe(true);
    expect(isOmpWebSearchTool("tools.web_search")).toBe(true);
    expect(isOmpWebSearchTool("mcp__exa__web_search")).toBe(false);
    expect(isOmpWebSearchTool("web_search_exa")).toBe(false);
  });

  it("extracts eval args and logged cell output from the OMP details envelope", () => {
    expect(parseOmpEval(
      { language: "js", code: "console.log('ok')", title: "Run" },
      { content: [{ type: "text", text: "ok" }], details: { language: "js", cells: [{ title: "Run", code: "console.log('ok')", language: "js", output: "ok" }] } },
    )).toEqual({
      title: "Run", language: "js", code: "console.log('ok')", result: "ok",
      cells: [{ title: "Run", language: "js", code: "console.log('ok')", output: "ok" }], status: "complete",
    });
  });

  it("extracts OMP search sources from details.response.sources", () => {
    expect(parseOmpWebSearch({ query: "omp" }, {
      content: [{ type: "text", text: "Found results" }],
      details: { response: { sources: [{ title: "Docs", url: "https://example.test", snippet: "Read docs" }] } },
    })).toEqual({
      query: "omp", results: [{ title: "Docs", url: "https://example.test", snippet: "Read docs" }], rawOutput: "Found results", status: "complete",
    });
  });

  it("preserves unmatched output and error content", () => {
    expect(parseOmpWebSearch({ query: "omp" }, { results: "unexpected" }).rawOutput).toContain("unexpected");
    expect(parseOmpWebSearch({ query: "omp" }, { isError: true, content: [{ type: "text", text: "offline" }] })).toEqual({
      query: "omp", results: [], rawOutput: "offline", status: "error",
    });
  });

  it("handles running calls, plain text, and empty envelopes", () => {
    expect(parseOmpEval({ code: "await work()" }, undefined, true)).toEqual({
      language: undefined, title: undefined, code: "await work()", result: "", cells: [], status: "running",
    });
    expect(parseOmpWebSearch("query", "plain result").rawOutput).toBe("plain result");
    expect(parseOmpWebSearch(undefined, undefined).status).toBe("complete");
  });
});

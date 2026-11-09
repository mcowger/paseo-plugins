import { describe, expect, it } from "vitest";
import {
  extractCodeModeCode,
  isCodeModeTool,
  parseCodeModeCalls,
  parseCodeModeCatalog,
} from "./codemode";

describe("codemode tool parsing", () => {
  it("recognizes the execute tool name", () => {
    expect(isCodeModeTool("execute")).toBe(true);
    expect(isCodeModeTool("Execute")).toBe(true);
    expect(isCodeModeTool("tools.execute")).toBe(true);
    expect(isCodeModeTool("exec")).toBe(false);
    expect(isCodeModeTool("browser_evaluate")).toBe(false);
  });

  it("extracts script code from object and string inputs", () => {
    expect(extractCodeModeCode({ code: "return 1;" })).toBe("return 1;");
    expect(extractCodeModeCode(JSON.stringify({ code: "return 2;" }))).toBe("return 2;");
    expect(extractCodeModeCode({})).toBeUndefined();
    expect(extractCodeModeCode({ code: "  " })).toBeUndefined();
  });

  it("parses catalog discovery searches", () => {
    const parsed = parseCodeModeCalls('const s = search({query: "exa web search"});\nreturn s;');
    expect(parsed.searchQuery).toBe("exa web search");
    expect(parsed.calls).toEqual([]);
  });

  it("parses namespaced tool calls with queries", () => {
    const parsed = parseCodeModeCalls('const r = await exa.web_search_exa({query: "hi"});\nreturn r;');
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.path).toBe("exa.web_search_exa");
    expect(parsed.calls[0]?.query).toBe("hi");
  });

  it("handles tools-prefixed paths and ignores globals", () => {
    const parsed = parseCodeModeCalls(
      'const [a, b] = await Promise.all([tools.github.search_code({query: "x"}), tools.github.search_code({query: "x"})]);\nreturn a;',
    );
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.path).toBe("github.search_code");
  });

  it("parses the catalog output shape", () => {
    const output = {
      items: [
        { path: "tools.exa.web_search_exa", description: "Search", signature: "tools.exa.web_search_exa()" },
        { path: "tools.exa.web_fetch_exa", description: "Fetch" },
      ],
      remaining: 51,
      next: { offset: 10 },
    };
    const catalog = parseCodeModeCatalog(output);
    expect(catalog?.items).toHaveLength(2);
    expect(catalog?.items[0]?.path).toBe("tools.exa.web_search_exa");
    expect(catalog?.remaining).toBe(51);
  });

  it("rejects non-catalog outputs", () => {
    expect(parseCodeModeCatalog({ results: [] })).toBeUndefined();
    expect(parseCodeModeCatalog("not json")).toBeUndefined();
  });
});

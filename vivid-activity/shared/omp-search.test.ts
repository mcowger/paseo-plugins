import { describe, expect, it } from "vitest";
import { isOmpGlobTool, isOmpGrepTool, parseOmpSearchResult } from "./omp-search";

describe("OMP grep and glob presentation", () => {
  it("recognizes only bare or explicitly namespaced tool names", () => {
    expect(isOmpGrepTool("grep")).toBe(true);
    expect(isOmpGrepTool("functions.grep")).toBe(true);
    expect(isOmpGlobTool("tools.glob")).toBe(true);
    expect(isOmpGlobTool("provider.grep")).toBe(false);
    expect(isOmpGlobTool("find")).toBe(false);
  });
  it("parses actual grep details and retains content for readable matches", () => {
    expect(parseOmpSearchResult({ pattern: "TODO", path: "src" }, {
      content: "src/a.ts:4: TODO", details: { scopePath: "src", searchPath: "src", matchCount: 1, fileCount: 1, files: [], fileMatches: [{ path: "src/a.ts", count: 1 }], truncated: false, displayContent: "src/a.ts:4: TODO", meta: { elapsedMs: 2 } },
    }, "grep")).toMatchObject({ pattern: "TODO", path: "src", matches: [{ path: "src/a.ts", line: 4, text: " TODO" }], fileMatches: [{ path: "src/a.ts", count: 1 }], matchCount: 1, fileCount: 1, truncated: false, text: ["src/a.ts:4: TODO"] });
  });

  it("treats glob argument path as its pattern and lists output files", () => {
    expect(parseOmpSearchResult({ path: "**/*.ts" }, { content: "src/a.ts", details: { scopePath: "src", fileCount: 1, files: ["src/a.ts"], truncated: false, cwd: "/repo" } }, "glob")).toMatchObject({
      pattern: "**/*.ts", files: ["src/a.ts"], truncated: false,
    });
  });

  it("retains unmatched/truncated output and error text", () => {
    expect(parseOmpSearchResult({}, { error: { message: "permission denied" }, content: "partial output\noutput truncated" })).toMatchObject({
      text: ["partial output", "output truncated"], error: "permission denied", truncated: true,
    });
  });

  it("handles a string output even when input is absent", () => {
    expect(parseOmpSearchResult(undefined, "src/a.ts\nsrc/b.ts", "glob")).toMatchObject({ files: ["src/a.ts", "src/b.ts"] });
  });
});

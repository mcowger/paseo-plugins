import { describe, expect, it } from "vitest";
import {
  githubOutputText,
  githubOutputValue,
  githubResultCount,
  githubToolIcon,
  githubToolKind,
  githubToolLabel,
  githubToolSummary,
} from "./github";

describe("GitHub tool presentation", () => {
  it("recognizes direct and namespaced GitHub tools", () => {
    expect(githubToolKind("github_search_repositories")).toBe("search-repositories");
    expect(githubToolKind("mcp__github__search_code")).toBe("search-code");
    expect(githubToolKind("github_pull_request_read")).toBe("pull-request");
    expect(githubToolKind("github_actions_run_trigger")).toBe("actions-run");
    expect(githubToolKind("exa_web_fetch_exa")).toBeNull();
  });

  it("provides labels, icons, and useful summaries", () => {
    expect(githubToolLabel("search-repositories")).toBe("GitHub Repository Search");
    expect(githubToolIcon("pull-request")).toBe("GitPullRequest");
    expect(
      githubToolSummary("pull-request", { owner: "getpaseo", repo: "paseo", pullNumber: 42 }),
    ).toBe("getpaseo/paseo#42");
    expect(githubToolSummary("file", { path: "packages/server/index.ts" })).toBe(
      "packages/server/index.ts",
    );
  });

  it("says how much of a match set a row is showing", () => {
    // A three-row page under a bare "Total 146" reads as a bug; "3 of 146" reads as a preview.
    expect(githubResultCount(3, 146)).toBe("3 of 146");
    // A response that returned everything needs no ratio.
    expect(githubResultCount(3, 3)).toBe("3");
    expect(githubResultCount(3, undefined)).toBe("3");
    expect(githubResultCount(3, 0)).toBe("3");
  });

  it("unwraps structured and text MCP envelopes", () => {
    const output = {
      structuredContent: {
        total_count: 1,
        items: [{ full_name: "getpaseo/paseo" }],
      },
      content: [{ type: "text", text: "fallback" }],
    };
    expect(githubOutputValue(output)).toEqual(output.structuredContent);
    expect(githubOutputText({ content: [{ type: "text", text: "workflow logs" }] })).toBe(
      "workflow logs",
    );
  });

  it("reads a repository search out of Pi's text envelope", () => {
    // Pi hands the payload back as a string next to its own bookkeeping; nothing here is
    // `content: [{ type: "text" }]`, which is why the row used to report zero results.
    const output = {
      content: JSON.stringify({
        total_count: 146,
        incomplete_results: false,
        items: [{ full_name: "omercnet/paseo-plugins", stargazers_count: 23 }],
      }),
      details: { server: "github", tool: "search_repositories" },
    };
    expect(githubOutputValue(output)).toEqual({
      total_count: 146,
      incomplete_results: false,
      items: [{ full_name: "omercnet/paseo-plugins", stargazers_count: 23 }],
    });
  });

  it("parses JSON embedded in MCP text", () => {
    const output = {
      content: [
        {
          type: "text",
          text: 'result_count=1\n\n{"items":[{"name":"README.md"}]}',
        },
      ],
    };
    expect(githubOutputValue(output)).toEqual({ items: [{ name: "README.md" }] });
  });
});

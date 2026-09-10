import { describe, expect, it } from "vitest";
import {
  githubOutputText,
  githubOutputValue,
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

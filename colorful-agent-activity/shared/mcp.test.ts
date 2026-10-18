import { describe, expect, it } from "vitest";
import {
  mcpCallFields,
  mcpServerLabel,
  mcpToolLabel,
  mcpToolSummary,
  parseMcpToolName,
} from "./mcp";
import { isRecallTool, parseRecallOutput, recallSummary } from "./recall";

describe("MCP tool names", () => {
  it("splits a server from its tool", () => {
    expect(parseMcpToolName("mcp__github__pull_request_read")).toEqual({
      server: "github",
      tool: "pull_request_read",
    });
    expect(parseMcpToolName("mcp__nginx_proxy_manager__list_hosts")).toEqual({
      server: "nginx_proxy_manager",
      tool: "list_hosts",
    });
    // Not an MCP tool.
    expect(parseMcpToolName("bash")).toBeUndefined();
    expect(parseMcpToolName("mcp__")).toBeUndefined();
  });

  it("labels a server the way a person writes it", () => {
    expect(mcpServerLabel("nginx_proxy_manager")).toBe("Nginx Proxy Manager");
    expect(mcpServerLabel("github")).toBe("GitHub");
    expect(mcpServerLabel("unraid")).toBe("Unraid");
    // Unknown servers still read better than the raw slug.
    expect(mcpServerLabel("home_assistant")).toBe("Home Assistant");
    expect(mcpToolLabel("pull_request_read")).toBe("Pull Request Read");
  });

  it("summarizes the tool plus the arguments that identify the call", () => {
    expect(mcpToolSummary("list_hosts", {})).toBe("List Hosts");
    expect(mcpToolSummary("docker_list", { container: "plex", all: true })).toBe(
      "Docker List · plex",
    );
    expect(mcpToolSummary("get_file_contents", { owner: "o", repo: "r", path: "a.ts" })).toBe(
      "Get File Contents · a.ts · o",
    );
    // Nothing scalar to say: just the tool.
    expect(mcpToolSummary("info", { nested: { a: 1 } })).toBe("Info");
  });

  it("renders arguments as field rows and drops empties", () => {
    expect(mcpCallFields({ container: "plex", all: true, empty: "", missing: null })).toEqual([
      ["Container", "plex"],
      ["All", true],
    ]);
    expect(mcpCallFields("not an object")).toEqual([]);
  });
});

describe("recall results", () => {
  // Captured from a real vcc_recall call.
  const output = [
    'Page 1/10 (50 total matches — showing 50 of 129 matches, refine your query for more precise results) for "unconsumed tool details":',
    "",
    "#1732 [tool_result] 2026-10-18T04:47:05.916Z  stdout    [plexuspi] unconsumed tool details for \"edit\"",
    "...(4 lines below)",
    "",
    "#1878 [tool_result] 2026-10-18T04:47:06.042Z  stdout    [plexuspi] unconsumed tool details for \"Agent\"",
    "",
    "#1742 [tool_result]   kind: ToolDetailKind;",
    "--- Read around a hit: range:[1729, 1735]; full text: expand:[1732] ---",
    "--- Use page:2 for more results ---",
  ].join("\n");

  it("reads the page header, the hits, and the hints", () => {
    const parsed = parseRecallOutput(output);
    expect(parsed).toBeDefined();
    expect(parsed).toMatchObject({ page: 1, pages: 10, shown: 50, total: 129, query: "unconsumed tool details" });
    expect(parsed?.entries).toHaveLength(3);
    expect(parsed?.entries[0]).toEqual({
      index: 1732,
      kind: "tool_result",
      time: "2026-10-18T04:47:05.916Z",
      preview: 'stdout [plexuspi] unconsumed tool details for "edit"',
      note: "...(4 lines below)",
    });
    expect(parsed?.hints).toEqual([
      "Read around a hit: range:[1729, 1735]; full text: expand:[1732]",
      "Use page:2 for more results",
    ]);
  });

  it("summarizes as counts, page, and query", () => {
    expect(recallSummary(parseRecallOutput(output)!)).toBe(
      '50 of 129 · page 1/10 · "unconsumed tool details"',
    );
    expect(
      recallSummary({ entries: [{ index: 1, kind: "assistant", preview: "" }], hints: [] }),
    ).toBeUndefined();
  });

  it("leaves output it cannot read to the existing rendering", () => {
    expect(parseRecallOutput("No results.")).toBeUndefined();
    expect(parseRecallOutput("")).toBeUndefined();
    expect(parseRecallOutput(undefined)).toBeUndefined();
  });

  it("recognizes the tool by name", () => {
    expect(isRecallTool("vcc_recall")).toBe(true);
    expect(isRecallTool("mcp__session__recall")).toBe(true);
    expect(isRecallTool("bash")).toBe(false);
  });
});

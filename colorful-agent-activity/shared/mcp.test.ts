import { describe, expect, it } from "vitest";
import {
  mcpCallFields,
  mcpServerLabel,
  mcpToolLabel,
  mcpResultFields,
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
    expect(mcpToolSummary({ server: "nginx_proxy_manager", tool: "list_hosts" }, {})).toBe(
      "List Hosts",
    );
    expect(
      mcpToolSummary({ server: "unraid", tool: "docker_list" }, { container: "plex", all: true }),
    ).toBe("Docker List · plex");
    expect(
      mcpToolSummary(
        { server: "github", tool: "get_file_contents" },
        { owner: "o", repo: "r", path: "a.ts" },
      ),
    ).toBe("Get File Contents · a.ts · o · r");
    // One tool with an action/subaction pair says what it did across both.
    expect(
      mcpToolSummary({ server: "unraid", tool: "unraid" }, { action: "system", subaction: "overview" }),
    ).toBe("system · overview");
    // Nothing scalar to say: just the tool.
    expect(mcpToolSummary({ server: "olive", tool: "info" }, { nested: { a: 1 } })).toBe("Info");
  });

  it("renders a JSON result as field rows, not a blob", () => {
    expect(
      mcpResultFields('{"summary":{"os":"Unraid OS 7.3","hostname":"Shark"},"uptime_ms":12}'),
    ).toEqual({
      fields: [
        ["Summary", { os: "Unraid OS 7.3", hostname: "Shark" }],
        ["Uptime Ms", 12],
      ],
      omitted: 0,
    });
    // An array result is one row of items, which the field renderer lists.
    expect(mcpResultFields('["a","b"]')).toEqual({ fields: [["Items", ["a", "b"]]], omitted: 0 });
    // Prose, logs, and partial bodies keep the code block.
    expect(mcpResultFields("Error: not found")).toBeUndefined();
    expect(mcpResultFields("{\"broken\":")).toBeUndefined();
    expect(mcpResultFields("{}")).toBeUndefined();
    expect(mcpResultFields(undefined)).toBeUndefined();
  });

  it("caps a huge payload and counts what it left out", () => {
    const wide = JSON.stringify(
      Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`key${index}`, index])),
    );
    const view = mcpResultFields(wide);
    expect(view?.fields).toHaveLength(20);
    expect(view?.omitted).toBe(5);
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

  it("keeps a hit's own continuation lines, up to what the row shows", () => {
    const parsed = parseRecallOutput(
      [
        'Page 1/1 (2 total matches) for "x":',
        "",
        "#2000 [tool_result] first line",
        "shared/presentation.ts:541: export function agentRowFacts(",
        "second line of content",
        "third line",
        "fourth line that the row cannot show",
        "",
        "#114 [user] just one line",
      ].join("\n"),
    );
    expect(parsed?.entries[0]?.preview).toBe(
      "first line\nshared/presentation.ts:541: export function agentRowFacts(\nsecond line of content",
    );
    expect(parsed?.entries[1]?.preview).toBe("just one line");
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

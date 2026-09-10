import { describe, expect, it } from "vitest";

import { resolvePiToolPatterns } from "./tool-patterns.js";

describe("resolvePiToolPatterns", () => {
  const tools = ["read", "bash", "edit", "mcp_linear_search", "mcp_linear_create"];

  it("matches exact names and glob patterns", () => {
    expect(resolvePiToolPatterns(tools, ["read", "mcp_linear_*"])).toEqual([
      "read",
      "mcp_linear_search",
      "mcp_linear_create",
    ]);
  });

  it("treats an empty pattern list as an empty allowlist", () => {
    expect(resolvePiToolPatterns(tools, [])).toEqual([]);
  });

  it("ignores blank patterns", () => {
    expect(resolvePiToolPatterns(tools, ["", "  ", "bash"])).toEqual(["bash"]);
  });
});

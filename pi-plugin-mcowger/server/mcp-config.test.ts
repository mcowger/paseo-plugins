import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createPiMcpConfig } from "./mcp-config.js";

test("writes a private Pi-native MCP configuration", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "paseo-pi-agent-"));
  const config = createPiMcpConfig({
    local: { type: "stdio", command: "node", args: ["server.mjs"], env: { TOKEN: "secret" } },
    remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer token" } },
  }, { PI_CODING_AGENT_DIR: agentDir });
  expect(config).not.toBeNull();
  try {
    expect(JSON.parse(readFileSync(config!.path, "utf8"))).toEqual({
      mcpServers: {
        local: { command: "node", args: ["server.mjs"], env: { TOKEN: "secret" } },
        remote: { url: "https://example.test/mcp", headers: { Authorization: "Bearer token" }, auth: false, oauth: false },
      },
    });
  } finally {
    config?.cleanup();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("merges session MCP servers with Pi's global configuration", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "paseo-pi-agent-"));
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: { global: { command: "global-server" } },
  }));
  const config = createPiMcpConfig(
    { local: { type: "stdio", command: "local-server" } },
    { PI_CODING_AGENT_DIR: agentDir },
  );
  try {
    expect(JSON.parse(readFileSync(config!.path, "utf8"))).toMatchObject({
      mcpServers: {
        global: { command: "global-server" },
        local: { command: "local-server" },
      },
    });
  } finally {
    config?.cleanup();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

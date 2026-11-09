import { describe, expect, it } from "vitest";
import { claimsToolCall, wireRowFromEntry } from "./fold-index";
import { pluginCardOf } from "./plugin-cards";

const reply = "Proposal p-0a1b2c3d4e: the user sees the skill release-notes as a card in this chat and decides whether to save it. Don't save it yourself.";
const proposal = (name: string, output: unknown, status = "completed") => ({ type: "tool_call", callId: "c1", name, status, error: null, detail: { type: "unknown", input: {}, output } });
const signIn = (output: unknown, name = "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", status = "completed") => ({ type: "tool_call", callId: "c2", name, status, error: null, detail: { type: "unknown", input: {}, output } });
const results = (url: unknown) => ({ data: { results: { notion: { redirect_url: url, accounts: [{ id: "word-id", alias: "work" }] } } } });

describe("Bots cards (0.5.0, mirroring Bots' proposalIdOf and appSignIns)", () => {
  it("recognises a finished proposal under every provider's name for the tool", () => {
    for (const name of ["mcp__bots__propose_skill", "bots.propose_routine", "bots_propose_changes", " mcp__bots__propose_changes "]) {
      expect(pluginCardOf(proposal(name, reply)), name).toBe("bots-proposal");
    }
  });

  it("reads the proposal id from text, MCP content blocks and the Claude provider's { output } wrapper", () => {
    expect(pluginCardOf(proposal("mcp__bots__propose_skill", { output: reply }))).toBe("bots-proposal");
    expect(pluginCardOf(proposal("mcp__bots__propose_skill", [{ type: "text", text: reply }]))).toBe("bots-proposal");
    expect(pluginCardOf(proposal("bots.propose_skill", { content: [{ type: "text", text: reply }] }))).toBe("bots-proposal");
  });

  it("leaves everything else to this plugin, as Bots does", () => {
    // Still running, no proposal id, a failed call: Bots draws no card.
    expect(pluginCardOf(proposal("mcp__bots__propose_skill", reply, "running"))).toBeNull();
    expect(pluginCardOf(proposal("mcp__bots__propose_skill", "Proposal saved."))).toBeNull();
    expect(pluginCardOf(proposal("mcp__bots__propose_skill", reply, "failed"))).toBeNull();
    // Bots' other tools, and tools of the same name on another server.
    expect(pluginCardOf(proposal("mcp__bots__ask_bot", reply))).toBeNull();
    expect(pluginCardOf(proposal("mcp__other__propose_skill", reply))).toBeNull();
    expect(pluginCardOf(proposal("propose_skill", reply))).toBeNull();
  });

  it("recognises an app sign-in with an https composio.dev link, however the output is wrapped", () => {
    const url = "https://backend.composio.dev/s/AbC123";
    expect(pluginCardOf(signIn(results(url)))).toBe("bots-sign-in");
    expect(pluginCardOf(signIn(JSON.stringify(results(url)), "composio.COMPOSIO_MANAGE_CONNECTIONS"))).toBe("bots-sign-in");
    expect(pluginCardOf(signIn({ output: [{ type: "text", text: JSON.stringify(results(url)) }] }, "composio_COMPOSIO_MANAGE_CONNECTIONS"))).toBe("bots-sign-in");
    expect(pluginCardOf(signIn({ content: [{ type: "text", text: JSON.stringify(results("https://composio.dev/x")) }] }))).toBe("bots-sign-in");
  });

  it("draws no sign-in card without a usable link", () => {
    expect(pluginCardOf(signIn(results("http://backend.composio.dev/s/1")))).toBeNull();
    expect(pluginCardOf(signIn(results("https://composio.dev.evil.test/s/1")))).toBeNull();
    expect(pluginCardOf(signIn(results(undefined)))).toBeNull();
    expect(pluginCardOf(signIn({ data: { results: {} } }))).toBeNull();
    expect(pluginCardOf(signIn("not json"))).toBeNull();
    expect(pluginCardOf(signIn(results("https://backend.composio.dev/s/1"), "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", "running"))).toBeNull();
    expect(pluginCardOf(signIn(results("https://backend.composio.dev/s/1"), "mcp__composio__COMPOSIO_SEARCH_TOOLS"))).toBeNull();
  });

  it("is a segment boundary in the fold index and not a row this plugin draws", () => {
    const card = proposal("mcp__bots__propose_skill", { output: reply });
    expect(claimsToolCall(card)).toBe(false);
    expect(claimsToolCall({ ...card, status: "running" })).toBe(true);
    const at = "2026-01-01T00:00:10.000Z";
    expect(wireRowFromEntry({ seqStart: 4, timestamp: at, provider: "claude", item: card })).toMatchObject({ s: 4, k: "b", w: "bots-proposal" });
    expect(wireRowFromEntry({ seqStart: 5, timestamp: at, provider: "codex", item: signIn(results("https://backend.composio.dev/s/1")) })).toMatchObject({ k: "b", w: "bots-sign-in" });
    expect(wireRowFromEntry({ seqStart: 6, timestamp: at, provider: "claude", item: { ...card, status: "running" } })).toMatchObject({ k: "t", key: "t:c1", st: "running", look: "mcp" });
  });
});

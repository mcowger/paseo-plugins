import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import { createTimeline, toolDetailDiagnostic } from "./timeline";

/**
 * Replays real Pi tool results, captured from transcripts, through the timeline.
 *
 * These exist because the mapping was written from Pi's help text and got five
 * tools wrong in the same way: the payload was on the other side of the call
 * (`write` keeps the file in its arguments, `edit` reports the patch on its
 * result, `todo` reports the list on its result). Every fixture here is a shape
 * Pi actually produced, and the last test asserts that nothing it reports is left
 * unaccounted — so when Pi changes or adds a field, this fails instead of a row
 * quietly losing content.
 */

interface CapturedResult {
  tool: string;
  args: unknown;
  /** Result content blocks, exactly as Pi sends them. */
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

const EDIT_PATCH = [
  "--- /app/src/a.ts",
  "+++ /app/src/a.ts",
  "@@ -1,1 +1,1 @@",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

const CAPTURED: CapturedResult[] = [
  {
    tool: "bash",
    args: { command: "npm test" },
    content: [
      {
        type: "text",
        text: "Test Files  21 passed (21)\n     Tests  282 passed (282)",
      },
    ],
  },
  {
    tool: "bash",
    args: { command: "seq 1 100000" },
    content: [{ type: "text", text: "" }],
    details: {
      fullOutputPath: "/tmp/pi-bash-a5950ead4540e3ff.log",
      truncation: {
        content: "",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 100_000,
        totalBytes: 251_031,
        outputLines: 0,
        outputBytes: 0,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
      },
    },
  },
  {
    tool: "edit",
    args: { path: "/app/src/a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in /app/src/a.ts." }],
    details: {
      diff: "    ...\n-1 const a = 1;\n+1 const a = 2;\n    ...",
      firstChangedLine: 1,
      patch: EDIT_PATCH,
    },
  },
  {
    tool: "read",
    args: { path: "README.md", offset: 20, limit: 40 },
    content: [{ type: "text", text: "# PlexusPi\n\nExperimental Paseo provider for Pi." }],
  },
  {
    tool: "write",
    args: { path: "src/a.ts", content: "export const a = 1;\n" },
    content: [{ type: "text", text: "Successfully wrote to /app/src/a.ts" }],
  },
  {
    tool: "grep",
    args: { pattern: "agentRowFacts" },
    content: [
      {
        type: "text",
        text: "shared/presentation.ts:541: export function agentRowFacts(\nclient/activity.tsx:46:   agentRowFacts,",
      },
    ],
  },
  {
    tool: "find",
    args: { pattern: "**/*.test.ts" },
    content: [{ type: "text", text: "client/bundle.test.ts\nshared/color.test.ts" }],
  },
  {
    tool: "ls",
    args: { path: "node_modules" },
    content: [{ type: "text", text: ".cache/\n@types/\nccount/\n" }],
  },
  {
    tool: "todo",
    args: { action: "create", subject: "Inspect working tree status" },
    content: [{ type: "text", text: "Created #1: Inspect working tree status (pending)" }],
    details: {
      action: "create",
      params: { action: "create", subject: "Inspect working tree status" },
      tasks: [{ id: 1, subject: "Inspect working tree status", status: "pending" }],
      nextId: 2,
    },
  },
  {
    tool: "Agent",
    args: { description: "Render check", prompt: "Reply ok", subagent_type: "explore" },
    content: [
      {
        type: "text",
        text: "Agent started in background.\nAgent ID: 87b979b09246\nType: explore\nDescription: Render check\nOutput file: /run/user/1000/subagents/87b979b09246.jsonl",
      },
    ],
    details: {
      agentId: "87b979b09246",
      description: "Render check",
      displayName: "explore",
      durationMs: 0,
      modelName: "deepseek-v4.1-flash",
      status: "background",
      subagentType: "explore",
      tags: ["thinking: high", "background"],
      tokens: "",
      toolUses: 0,
    },
  },
  {
    tool: "get_subagent_result",
    args: { agent_id: "87b979b09246", wait: true },
    content: [
      {
        type: "text",
        text: "Agent: 87b979b09246\nOperation: wait\nType: explore | Status: completed\nDescription: Render check\nTool uses: 0 | 7.5k token | Context: 1% | Duration: 1.9s\n\nok",
      },
    ],
    details: {
      agentId: "87b979b09246",
      description: "Render check",
      operation: "wait",
      status: "completed",
      subagentType: "explore",
    },
  },
  {
    tool: "ask_user_question",
    args: { questions: [{ question: "Where should the settings live?" }] },
    content: [
      {
        type: "text",
        text: 'User has answered your questions: "Where should the settings live?"="Match chat-polish".',
      },
    ],
    details: {
      answers: [
        {
          questionIndex: 0,
          question: "Where should the settings live?",
          answer: "Match chat-polish",
        },
      ],
      cancelled: false,
    },
  },
  {
    tool: "mcp__github__get_file_contents",
    args: { owner: "o", repo: "r", path: "package.json" },
    content: [
      { type: "text", text: "successfully downloaded text file (SHA: 556cfef80e)" },
      { type: "text", text: '{\n  "name": "colorful-agent-activity"\n}' },
    ],
    details: { server: "github", tool: "get_file_contents" },
  },
];

function replay(captured: CapturedResult) {
  const { timeline } = (() => {
    const timeline = createTimeline({ sessionId: "fixture", emit: () => {} });
    return { timeline };
  })();
  const callId = `call-${captured.tool}`;
  timeline.accept({
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: captured.tool,
    args: captured.args,
  });
  timeline.accept({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: captured.tool,
    args: captured.args,
    result: { content: captured.content },
    details: captured.details,
  });
  return timeline.items();
}

function detailOf(items: readonly ProviderTimelineItem[], tool: string) {
  const item = items.find((entry) => entry.type === "tool_call" && entry.name === tool);
  if (item?.type !== "tool_call") throw new Error(`No tool row for ${tool}`);
  return item;
}

describe("captured Pi tool results", () => {
  test.each(CAPTURED)("$tool maps onto the detail its row needs", (captured) => {
    const items = replay(captured);
    if (captured.tool === "todo") {
      // A task list is not a tool row: the card replaces it, so there is nothing
      // else to look at.
      expect(items.filter((entry) => entry.type === "tool_call")).toHaveLength(0);
      expect(items.find((entry) => entry.type === "todo")).toMatchObject({
        type: "todo",
        items: [{ text: "Inspect working tree status", status: "pending" }],
      });
      return;
    }
    const item = detailOf(items, captured.tool);
    // The payload has to survive the trip: this is the assertion that failed for
    // edit (no diff), write (the confirmation instead of the file) and todo (text
    // instead of a list).
    const detail = item.detail as Record<string, unknown>;
    switch (captured.tool) {
      case "bash":
        expect(detail).toMatchObject({
          type: "shell",
          command: String((captured.args as { command: string }).command),
        });
        if (captured.details) {
          expect(item.metadata).toEqual({
            plexuspiFacts: {
              truncated: true,
              totalBytes: 251_031,
              totalLines: 100_000,
              fullOutputPath: "/tmp/pi-bash-a5950ead4540e3ff.log",
            },
          });
        }
        break;
      case "edit":
        expect(detail).toMatchObject({
          type: "edit",
          filePath: "/app/src/a.ts",
          unifiedDiff: EDIT_PATCH,
        });
        break;
      case "read":
        expect(detail).toMatchObject({
          type: "read",
          filePath: "README.md",
          offset: 20,
          limit: 40,
        });
        expect(String(detail.content)).toContain("PlexusPi");
        break;
      case "write":
        expect(detail).toMatchObject({ type: "write", content: "export const a = 1;\n" });
        break;
      case "grep":
        expect(detail).toMatchObject({ type: "search", toolName: "grep" });
        expect(String(detail.content)).toContain("presentation.ts:541:");
        break;
      case "find":
        expect(detail).toMatchObject({ type: "search", toolName: "glob" });
        break;
      case "ls":
        // Colorful renders this one by name; the provider only has to pass it on.
        expect(detail).toMatchObject({ type: "unknown" });
        expect(String(detail.output)).toContain("ccount/");
        break;
      case "Agent":
        expect(detail).toMatchObject({
          type: "sub_agent",
          subAgentType: "explore",
          description: "Render check",
          childSessionId: "87b979b09246",
        });
        // Facts its own detail cannot hold.
        expect(item.metadata).toMatchObject({
          plexuspiFacts: {
            status: "background",
            modelName: "deepseek-v4.1-flash",
            tags: "2 items",
          },
        });
        break;
      case "get_subagent_result":
        // Its curated row parses the result text, so the details add no facts.
        expect(detail).toMatchObject({ type: "unknown" });
        expect(String(detail.output)).toContain("Operation: wait");
        expect(item.metadata).toBeUndefined();
        break;
      case "ask_user_question":
        expect(detail).toMatchObject({ type: "unknown" });
        expect(String(detail.output)).toContain("Match chat-polish");
        break;
      case "mcp__github__get_file_contents":
        // Two blocks stay two lines, and transport details add no facts.
        expect(detail).toMatchObject({
          type: "unknown",
          output:
            'successfully downloaded text file (SHA: 556cfef80e)\n{\n  "name": "colorful-agent-activity"\n}',
        });
        expect(item.metadata).toBeUndefined();
        break;
    }
  });
});

describe("captured detail shapes are fully accounted for", () => {
  const withDetails = CAPTURED.filter((captured) => captured.details !== undefined);

  test.each(withDetails)("$tool reports no unaccounted detail keys", (captured) => {
    // The tripwire: when Pi adds a field, this fails and names it, instead of the
    // field disappearing from every row.
    expect(toolDetailDiagnostic(captured.tool, captured.details)).toBeNull();
  });

  test("covers every tool the mapping has a branch for", () => {
    // If a branch is added, add its captured shape here too.
    const branched = ["bash", "edit", "read", "write", "grep", "find", "todo", "Agent"];
    for (const tool of branched) {
      expect(CAPTURED.some((captured) => captured.tool === tool)).toBe(true);
    }
  });
});

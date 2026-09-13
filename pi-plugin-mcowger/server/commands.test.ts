import { describe, expect, it } from "vitest";

import { buildPiPromptCommands, parsePiSlashCommand } from "./commands.js";

describe("parsePiSlashCommand", () => {
  it("parses a command and preserves its trimmed arguments", () => {
    expect(parsePiSlashCommand("  /review   the changes  ")).toEqual({
      name: "review",
      arguments: "the changes",
    });
  });

  it("rejects ordinary text and nested slash names", () => {
    expect(parsePiSlashCommand("review the changes")).toBeNull();
    expect(parsePiSlashCommand("/review/path")).toBeNull();
    expect(parsePiSlashCommand("/")).toBeNull();
  });
});

describe("buildPiPromptCommands", () => {
  it("publishes extension commands, prompt templates, and skills", () => {
    const commands = buildPiPromptCommands(
      [
        {
          commands: new Map([
            ["review", { name: "review", description: "Review the current changes" }],
            ["compact", { name: "compact", description: "Extension compact" }],
            ["blank", { name: "", description: "Uses the registered name" }],
          ]),
        },
      ],
      [
        { name: "review", description: "Prompt review" },
        { name: "explain" },
      ],
      [
        { name: "code-review", description: "Review code changes" },
        { name: "  " },
      ],
    );

    expect(commands).toEqual([
      {
        name: "compact",
        description: "Manually compact the session context",
        argumentHint: "[instructions]",
      },
      {
        name: "settings",
        description: "Change Pi runtime settings",
        argumentHint: "<auto-compaction|auto-retry> <on|off>",
      },
      {
        name: "reload",
        description: "Reload Pi extensions, skills, prompts, themes, and context files",
      },
      { name: "session", description: "Show Pi session info and stats" },
      { name: "name", description: "Set the Pi session display name", argumentHint: "<name>" },
      { name: "review", description: "Review the current changes" },
      { name: "blank", description: "Uses the registered name" },
      { name: "explain", description: "Prompt template" },
      { name: "skill:code-review", description: "Review code changes" },
    ]);
  });

  it("uses a fallback description and ignores empty names", () => {
    const commands = buildPiPromptCommands(
      [{
        commands: new Map([
          ["status", { name: "status" }],
          [" ", { name: "  " }],
        ]),
      }],
      [{ name: "  ", description: "Empty" }],
      [{ name: "deploy" }],
    );

    expect(commands).toHaveLength(7);
    expect(commands.at(-2)).toEqual({
      name: "status",
      description: "Pi extension command",
    });
    expect(commands.at(-1)).toEqual({
      name: "skill:deploy",
      description: "Pi skill",
    });
  });
});

import { describe, expect, it } from "vitest";

import { buildPiPromptCommands } from "./commands.js";

describe("buildPiPromptCommands", () => {
  it("publishes extension commands with built-ins and prompt templates", () => {
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
    );

    expect(commands).toEqual([
      {
        name: "compact",
        description: "Manually compact the session context",
        argumentHint: "[instructions]",
      },
      {
        name: "preset",
        description: "Activate a pi preset",
        argumentHint: "<name>",
      },
      { name: "review", description: "Review the current changes" },
      { name: "blank", description: "Uses the registered name" },
      { name: "explain", description: "Prompt template" },
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
    );

    expect(commands).toHaveLength(3);
    expect(commands.at(-1)).toEqual({
      name: "status",
      description: "Pi extension command",
    });
  });
});

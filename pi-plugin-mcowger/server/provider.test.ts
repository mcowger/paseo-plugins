import { describe, expect, it } from "vitest";

import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";

import { createPiProvider } from "./provider.js";

function nextEvent(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => boolean,
): ProviderEvent {
  const event = events.find(predicate);
  if (!event) throw new Error("Expected provider event");
  return event;
}

describe("Pi provider rewind capability", () => {
  it("advertises conversation rewind when capabilities are negotiated", async () => {
    const provider = createPiProvider();
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["session.persistence", "session.revert.conversation"],
    });

    try {
      expect(connection.capabilities).toEqual([
        "session.persistence",
        "session.revert.conversation",
      ]);
    } finally {
      await connection.close();
    }
  });

  it("rejects file rewind through the provider boundary", async () => {
    const provider = createPiProvider();
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["session.revert.conversation"],
    });
    const events: ProviderEvent[] = [];
    const unsubscribe = connection.onEvent((event) => events.push(event));
    try {
      const input: ProviderInput = {
        type: "session.revert",
        requestId: "rewind-files",
        sessionId: "missing",
        token: "entry-1",
        scope: "files",
      };
      await connection.send(input);

      expect(nextEvent(events, (event) => event.type === "request.failed")).toEqual(
        expect.objectContaining({
          type: "request.failed",
          requestId: "rewind-files",
          error: { message: "Pi does not support files rewind" },
        }),
      );
    } finally {
      unsubscribe();
      await connection.close();
    }
  });
});

import { describe, expect, it } from "vitest";

import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";

import {
  createPiProvider,
  setActiveToolsOrCleanup,
  stripPiToolPolicyProfileMarker,
} from "./provider.js";
import { createPiToolPolicyStore } from "./tool-policy.js";
import { PI_TOOL_POLICY_PROFILE_ID_SETTING } from "../shared/tool-policy.js";

function nextEvent(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => boolean,
): ProviderEvent {
  const event = events.find(predicate);
  if (!event) throw new Error("Expected provider event");
  return event;
}

describe("Pi provider profile marker", () => {
  it("strips only the exact plugin marker before Pi settings handling", () => {
    expect(stripPiToolPolicyProfileMarker({
      autoCompaction: true,
      [PI_TOOL_POLICY_PROFILE_ID_SETTING]: "profile-build",
      otherSetting: "kept",
    })).toEqual({
      marker: "profile-build",
      settings: { autoCompaction: true, otherSetting: "kept" },
    });
  });

  it("retains malformed marker values for fallback selection without passing them to Pi", () => {
    expect(stripPiToolPolicyProfileMarker({
      [PI_TOOL_POLICY_PROFILE_ID_SETTING]: { invalid: true },
    })).toEqual({
      marker: { invalid: true },
      settings: {},
    });
  });
});

describe("Pi provider failed-open cleanup", () => {
  it.each([[[]], [["read", "bash"]]])("cleans up when active-tool application fails", async (toolNames) => {
    const error = new Error("active tools failed");
    let cleanupCalls = 0;
    const session = {
      setActiveToolsByName() {
        throw error;
      },
    };

    await expect(setActiveToolsOrCleanup(session, toolNames, async () => {
      cleanupCalls += 1;
    })).rejects.toBe(error);
    expect(cleanupCalls).toBe(1);
  });
});

describe("Pi provider rewind capability", () => {
  it("advertises conversation rewind when capabilities are negotiated", async () => {
    const provider = createPiProvider(createPiToolPolicyStore());
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
    const provider = createPiProvider(createPiToolPolicyStore());
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

import { describe, expect, it } from "vitest";

import {
  activePiProfileIdFromPersistenceData,
  activePiProfileIdFromRuntimeSessionId,
  readActivePiProfileId,
} from "./active-profile.js";

describe("active Pi profile identity", () => {
  it("validates a profile ID", () => {
    expect(readActivePiProfileId(" profile-build ")).toBe("profile-build");
    expect(readActivePiProfileId({ invalid: true })).toBeNull();
  });

  it("reads the exact profile ID from provider persistence", () => {
    expect(activePiProfileIdFromPersistenceData({ profileId: "profile-build" })).toBe("profile-build");
    expect(activePiProfileIdFromPersistenceData({ profileId: null })).toBeNull();
  });

  it("reads the profile ID from Paseo's plugin persistence handle", () => {
    expect(activePiProfileIdFromRuntimeSessionId(`plugin:${JSON.stringify({
      version: 2,
      data: { sessionFile: "/sessions/build.jsonl", profileId: "profile-build" },
    })}`)).toBe("profile-build");
  });

  it("rejects malformed or unrelated runtime session IDs", () => {
    expect(activePiProfileIdFromRuntimeSessionId("native-session-1")).toBeNull();
    expect(activePiProfileIdFromRuntimeSessionId("plugin:not-json")).toBeNull();
  });
});

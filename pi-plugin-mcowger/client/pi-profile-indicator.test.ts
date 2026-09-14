import { describe, expect, it } from "vitest";

import { resolvePiProfile } from "./pi-profile-indicator.js";

const explore = {
  id: "explore",
  name: "Explore",
  model: "plexus/gpt-5.6-luna",
  thinkingOptionId: "high",
};

const build = {
  id: "build",
  name: "Build",
  model: "plexus/gpt-5.6-luna",
  thinkingOptionId: "low",
};

describe("resolvePiProfile", () => {
  it("matches the exact active profile ID", () => {
    expect(resolvePiProfile("explore", [explore, build])).toEqual({
      kind: "matched",
      profile: explore,
    });
  });

  it("does not infer a profile when the provider has no marker", () => {
    expect(resolvePiProfile(null, [explore, build])).toEqual({
      kind: "not-identified",
    });
  });

  it("does not infer a profile from a missing profile record", () => {
    expect(resolvePiProfile("deleted", [explore, build])).toEqual({
      kind: "unknown",
    });
  });

  it("uses the profile ID even when launch settings are identical", () => {
    const duplicate = { ...explore, id: "explore-copy", name: "Explore copy" };
    expect(resolvePiProfile("explore-copy", [explore, duplicate])).toEqual({
      kind: "matched",
      profile: duplicate,
    });
  });
});

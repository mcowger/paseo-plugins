import { describe, expect, it } from "vitest";

import { saveProfilePolicyWithRetry } from "./profile-policy-sync.js";

describe("saveProfilePolicyWithRetry", () => {
  it("reloads and retries when a save returns false", async () => {
    const saves: boolean[] = [false, true];
    let reloads = 0;
    await saveProfilePolicyWithRetry(
      async () => saves.shift() ?? false,
      async () => { reloads += 1; },
      [0],
      async () => {},
    );
    expect(reloads).toBe(1);
  });

  it("surfaces rejected saves after bounded retries", async () => {
    let saves = 0;
    let reloads = 0;
    await expect(saveProfilePolicyWithRetry(
      async () => {
        saves += 1;
        throw new Error("revision conflict");
      },
      async () => { reloads += 1; },
      [0, 0],
      async () => {},
    )).rejects.toThrow("revision conflict");
    expect(saves).toBe(3);
    expect(reloads).toBe(2);
  });
});

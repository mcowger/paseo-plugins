import { describe, expect, it } from "vitest";
import {
  MAX_TRACKED_SKILLS,
  normalizeUsageName,
  recordSkillUsage,
  sortSkillsByUsage,
  type SkillUsage,
} from "./usage";

describe("normalizeUsageName", () => {
  it("strips slashes and trims", () => {
    expect(normalizeUsageName("/commit-push-pr")).toBe("commit-push-pr");
    expect(normalizeUsageName("  grill-me  ")).toBe("grill-me");
  });

  it("rejects empty and invalid names", () => {
    expect(normalizeUsageName(null)).toBeNull();
    expect(normalizeUsageName("")).toBeNull();
    expect(normalizeUsageName("has space")).toBeNull();
  });
});

describe("recordSkillUsage", () => {
  it("creates an entry with count 1", () => {
    const next = recordSkillUsage({ skills: {} }, "grill-me", "2026-01-01T00:00:00.000Z");
    expect(next.skills["grill-me"]).toEqual({ count: 1, lastUsedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("increments count and refreshes the timestamp", () => {
    const before: SkillUsage = {
      skills: { "grill-me": { count: 2, lastUsedAt: "2026-01-01T00:00:00.000Z" } },
    };
    const next = recordSkillUsage(before, "grill-me", "2026-02-01T00:00:00.000Z");
    expect(next.skills["grill-me"]).toEqual({ count: 3, lastUsedAt: "2026-02-01T00:00:00.000Z" });
  });

  it("ignores invalid names without mutating", () => {
    const before: SkillUsage = { skills: {} };
    expect(recordSkillUsage(before, "has space", "2026-01-01T00:00:00.000Z")).toEqual({
      skills: {},
    });
  });

  it("prunes to the most recently used entries", () => {
    const skills: SkillUsage["skills"] = {};
    for (let index = 0; index < MAX_TRACKED_SKILLS + 5; index += 1) {
      const at = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString();
      skills[`skill-${index}`] = { count: 1, lastUsedAt: at };
    }
    const next = recordSkillUsage({ skills }, "fresh", "2026-03-01T00:00:00.000Z");
    expect(Object.keys(next.skills)).toHaveLength(MAX_TRACKED_SKILLS);
    expect(next.skills["fresh"]).toEqual({ count: 1, lastUsedAt: "2026-03-01T00:00:00.000Z" });
    expect(next.skills["skill-0"]).toBeUndefined();
  });
});

describe("sortSkillsByUsage", () => {
  const skills = [
    { name: "commit-push-pr", description: "", argumentHint: "", kind: "skill" },
    { name: "grill-me", description: "", argumentHint: "", kind: "skill" },
    { name: "report", description: "", argumentHint: "", kind: "skill" },
  ];

  it("sorts most recently used first", () => {
    const usage: SkillUsage = {
      skills: {
        "grill-me": { count: 1, lastUsedAt: "2026-02-01T00:00:00.000Z" },
        report: { count: 9, lastUsedAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    expect(sortSkillsByUsage(skills, usage).map((skill) => skill.name)).toEqual([
      "grill-me",
      "report",
      "commit-push-pr",
    ]);
  });

  it("breaks recency ties by count, then name", () => {
    const usage: SkillUsage = {
      skills: {
        "commit-push-pr": { count: 1, lastUsedAt: "2026-01-01T00:00:00.000Z" },
        "grill-me": { count: 3, lastUsedAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    expect(sortSkillsByUsage(skills, usage).map((skill) => skill.name)).toEqual([
      "grill-me",
      "commit-push-pr",
      "report",
    ]);
  });

  it("falls back to name order without usage", () => {
    expect(sortSkillsByUsage(skills, null).map((skill) => skill.name)).toEqual([
      "commit-push-pr",
      "grill-me",
      "report",
    ]);
    expect(sortSkillsByUsage(skills, { skills: {} }).map((skill) => skill.name)).toEqual([
      "commit-push-pr",
      "grill-me",
      "report",
    ]);
  });
});

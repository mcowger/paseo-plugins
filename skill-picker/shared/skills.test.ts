import { describe, expect, it } from "vitest";
import { filterSkills, isSkillCommand, toSkillDisplayName, toSkillInvocation } from "./skills";

describe("isSkillCommand", () => {
  it("accepts skill entries with a name", () => {
    expect(isSkillCommand({ name: "commit-push-pr", kind: "skill" })).toBe(true);
  });

  it("rejects commands, unnamed entries, and nullish input", () => {
    expect(isSkillCommand({ name: "compact", kind: "command" })).toBe(false);
    expect(isSkillCommand({ name: "", kind: "skill" })).toBe(false);
    expect(isSkillCommand(null)).toBe(false);
    expect(isSkillCommand(undefined)).toBe(false);
  });
});

describe("filterSkills", () => {
  const commands = [
    { name: "commit-push-pr", description: "Commit and open a PR", kind: "skill" },
    { name: "compact", description: "Compact context", kind: "command" },
    { name: "grill-me", description: "Stress-test a plan", kind: "skill" },
  ];

  it("keeps only skills and sorts by name", () => {
    expect(filterSkills(commands, "").map((skill) => skill.name)).toEqual([
      "commit-push-pr",
      "grill-me",
    ]);
  });

  it("matches query against name and description", () => {
    expect(filterSkills(commands, "push").map((skill) => skill.name)).toEqual(["commit-push-pr"]);
    expect(filterSkills(commands, "stress").map((skill) => skill.name)).toEqual(["grill-me"]);
  });

  it("returns empty for nullish input", () => {
    expect(filterSkills(null, "")).toEqual([]);
    expect(filterSkills(undefined, "")).toEqual([]);
  });
});

describe("toSkillInvocation", () => {
  it("prefixes a slash", () => {
    expect(toSkillInvocation("commit-push-pr")).toBe("/commit-push-pr");
    expect(toSkillInvocation("/commit-push-pr")).toBe("/commit-push-pr");
  });

  it("preserves provider namespaces", () => {
    expect(toSkillInvocation("skill:opencodereview-cli")).toBe("/skill:opencodereview-cli");
    expect(toSkillInvocation("/skill:docs")).toBe("/skill:docs");
    expect(toSkillInvocation("ext:my-tool")).toBe("/ext:my-tool");
  });

  it("rejects empty or invalid names", () => {
    expect(() => toSkillInvocation("")).toThrow();
    expect(() => toSkillInvocation("has space")).toThrow();
    expect(() => toSkillInvocation("skill:")).toThrow();
    expect(() => toSkillInvocation(":skill")).toThrow();
  });
});

describe("toSkillDisplayName", () => {
  it("strips the skill namespace but keeps other namespaces", () => {
    expect(toSkillDisplayName("skill:opencodereview-cli")).toBe("opencodereview-cli");
    expect(toSkillDisplayName("/skill:docs")).toBe("docs");
    expect(toSkillDisplayName("commit-push-pr")).toBe("commit-push-pr");
    expect(toSkillDisplayName("ext:my-tool")).toBe("ext:my-tool");
  });
});

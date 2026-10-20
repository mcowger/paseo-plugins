import { describe, expect, it } from "vitest";
import { validateFeatureName } from "./config";
import { normalizeManifest } from "./manifest";
import {
  renderBranchName,
  renderConstituentDirName,
  renderRootDirName,
  resolveRootBase,
  sanitizeFeatureName,
} from "./names";
import { buildRepomap, renderAgentsTemplate } from "./repomap";

describe("validateFeatureName", () => {
  it("accepts ordinary and friendly display names", () => {
    expect(validateFeatureName("featureA")).toBeNull();
    expect(validateFeatureName("feat/login-flow")).toBeNull();
    expect(validateFeatureName("a")).toBeNull();
    expect(validateFeatureName("SIG: ABSCD - Fix My Stuff")).toBeNull();
    expect(validateFeatureName("a..b")).toBeNull();
    expect(validateFeatureName("has space")).toBeNull();
    expect(validateFeatureName("trail.lock")).toBeNull();
  });

  it("rejects empty and oversized display names", () => {
    expect(validateFeatureName("")).not.toBeNull();
    expect(validateFeatureName("   ")).not.toBeNull();
    expect(validateFeatureName("a".repeat(129))).not.toBeNull();
  });

  it.each(["line\nbreak", "tab\tname", "nul\u0000name", "rtl\u202ename", "zero\u200bwidth"])(
    "rejects control and invisible characters in %j",
    (feature) => expect(validateFeatureName(feature)).not.toBeNull(),
  );

  it("allows ordinary Unicode display names", () => {
    expect(validateFeatureName("修复登录")).toBeNull();
  });
});

describe("sanitizeFeatureName", () => {
  it.each([
    ["SIG: ABSCD - Fix My Stuff", "sig-abscd-fix-my-stuff"],
    ["  Café: fix [login]?!  ", "cafe-fix-login"],
    ["a..b", "a-b"],
    ["../outside", "outside"],
    ["/lead/", "lead"],
    ["a//b", "a-b"],
    ["a/.hidden", "a-hidden"],
    ["trail.lock", "trail-lock"],
    ["-option", "option"],
    ["HEAD", "head"],
    ["@{}\\\\bad", "bad"],
    ["???", "feature"],
    ["!!!", "!!!"],
    ["修 复", "feature"],
    ["修复", "修复"],
    ["réparer", "réparer"],
    ["featureA", "featureA"],
    ["feat/login-flow", "feat/login-flow"],
    ["release_1.2", "release_1.2"],
    ["a@x", "a@x"],
    ["@", "feature"],
    ["a\u202eb", "a-b"],
    ["a\u0085b", "a-b"],
  ])("sanitizes %j to %j", (input, expected) => {
    expect(sanitizeFeatureName(input)).toBe(expected);
    expect(sanitizeFeatureName(expected)).toBe(expected);
  });
});

describe("templates", () => {
  it("sanitizes friendly names in branches and directories, not display text", () => {
    const input = { uberProjectId: "uber", feature: "SIG: ABSCD - Fix My Stuff" };
    const branch = renderBranchName("feat/{feature}", input);
    expect(branch).toBe("feat/sig-abscd-fix-my-stuff");
    expect(renderBranchName("{feature}", input)).toBe("sig-abscd-fix-my-stuff");
    expect(renderBranchName("Work: {feature}", input)).toBe("work-sig-abscd-fix-my-stuff");
    expect(renderBranchName("{feature}@x", { ...input, feature: "featureA" })).toBe("featureA@x");
    expect(renderRootDirName("{uberProject}-{feature}", { ...input, branch })).toBe(
      "uber-sig-abscd-fix-my-stuff",
    );
    expect(renderConstituentDirName("{repo}_{feature}", { ...input, branch, repoId: "app" })).toBe(
      "app_sig-abscd-fix-my-stuff",
    );
  });
  it("renders names from templates", () => {
    expect(renderBranchName("{feature}", { uberProjectId: "uber", feature: "featureA" })).toBe(
      "featureA",
    );
    expect(
      renderRootDirName("{uberProject}-{feature}", {
        uberProjectId: "uber",
        feature: "featureA",
        branch: "featureA",
      }),
    ).toBe("uber-featureA");
    expect(
      renderConstituentDirName("{repo}_{branch}", {
        uberProjectId: "uber",
        feature: "featureA",
        branch: "featureA",
        repoId: "frontend",
      }),
    ).toBe("frontend_featureA");
  });

  it("resolves the root base with per-project, host, and default precedence", () => {
    expect(resolveRootBase({ perProject: "/a", hostSetting: "/b", paseoHome: "/h" })).toBe("/a");
    expect(resolveRootBase({ hostSetting: "/b", paseoHome: "/h" })).toBe("/b");
    expect(resolveRootBase({ paseoHome: "/h" })).toBe("/h/poly-workspaces");
  });
});

describe("agents template and repomap", () => {
  it("substitutes template tokens", () => {
    const rendered = renderAgentsTemplate("# {{uberProject}} {{feature}} {{branch}}\n{{repos}}\n", {
      uberProjectName: "Uber",
      feature: "featureA",
      branch: "featureA",
      repos: [{ repoId: "frontend", dirName: "frontend_featureA" }],
    });
    expect(rendered).toContain("Uber featureA featureA");
    expect(rendered).toContain("frontend_featureA/ (frontend)");
  });

  it("builds a repomap with per-repo sections", () => {
    const doc = buildRepomap({
      uberProjectName: "Uber",
      feature: "featureA",
      branch: "featureA",
      generatedAt: "2026-01-01T00:00:00.000Z",
      repos: [
        {
          repoId: "frontend",
          sourcePath: "/src/frontend",
          worktreePath: "/w/frontend_featureA",
          dirName: "frontend_featureA",
          branch: "featureA",
          baseBranch: "main",
          topLevelEntries: ["package.json", "src"],
          fragment: "readme words",
        },
      ],
    });
    expect(doc).toContain("## frontend");
    expect(doc).toContain("package.json, src");
    expect(doc).toContain("readme words");
  });
});

describe("normalizeManifest", () => {
  it("rejects malformed manifests", () => {
    expect(normalizeManifest(null)).toBeNull();
    expect(normalizeManifest({ version: 2 })).toBeNull();
    expect(normalizeManifest({ version: 1, state: "bogus" })).toBeNull();
  });
});

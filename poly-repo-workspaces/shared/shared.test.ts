import { describe, expect, it } from "vitest";
import { validateFeatureName } from "./config";
import { normalizeManifest } from "./manifest";
import {
  renderBranchName,
  renderConstituentDirName,
  renderRootDirName,
  resolveRootBase,
} from "./names";
import { buildRepomap, renderAgentsTemplate } from "./repomap";

describe("validateFeatureName", () => {
  it("accepts ordinary names", () => {
    expect(validateFeatureName("featureA")).toBeNull();
    expect(validateFeatureName("feat/login-flow")).toBeNull();
    expect(validateFeatureName("a")).toBeNull();
  });

  it("rejects git-unsafe and path-unsafe names", () => {
    expect(validateFeatureName("")).not.toBeNull();
    expect(validateFeatureName("a..b")).not.toBeNull();
    expect(validateFeatureName("has space")).not.toBeNull();
    expect(validateFeatureName("trail.lock")).not.toBeNull();
    expect(validateFeatureName("/lead")).not.toBeNull();
    expect(validateFeatureName("a~b")).not.toBeNull();
  });
});

describe("templates", () => {
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

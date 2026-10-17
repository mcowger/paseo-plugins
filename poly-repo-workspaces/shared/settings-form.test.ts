import { describe, expect, it } from "vitest";
import type { UberProject } from "./config";
import {
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_REPO_DIR_TEMPLATE,
  DEFAULT_ROOT_DIR_TEMPLATE,
  emptyProjectDraft,
  emptyRepoDraft,
  hasProjectErrors,
  previewProjectDraft,
  projectDraftFrom,
  projectFromDraft,
  validateProjectDraft,
} from "./settings-form";

const project: UberProject = {
  id: "checkout",
  displayName: "Checkout",
  branchTemplate: "feat-{feature}",
  rootDirTemplate: "{uberProject}-{feature}",
  agentsTemplatePath: "/templates/agents.md",
  repos: [
    { id: "frontend", sourcePath: "/src/frontend", dirTemplate: "{repo}_{branch}" },
    { id: "app", sourcePath: "/src/app", dirTemplate: "{repo}-{feature}", baseBranch: "main" },
  ],
};

function validDraft() {
  return projectDraftFrom(project, "test");
}

describe("projectDraftFrom", () => {
  it("round-trips a stored uber-project through the form draft", () => {
    expect(projectFromDraft(validDraft())).toEqual(project);
  });

  it("gives every repo row a distinct stable key", () => {
    const keys = validDraft().repos.map((repo) => repo.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("validateProjectDraft", () => {
  it("accepts a complete draft", () => {
    const errors = validateProjectDraft(validDraft(), []);
    expect(hasProjectErrors(errors)).toBe(false);
    expect(errors.repoErrors).toEqual({});
  });

  it("flags every required field on a fresh draft", () => {
    const errors = validateProjectDraft(emptyProjectDraft(), []);
    expect(errors.id).toBeDefined();
    expect(errors.displayName).toBeDefined();
    expect(errors.agentsTemplatePath).toBeDefined();
    expect(errors.repos).toContain("at least one repository");
    expect(hasProjectErrors(errors)).toBe(true);
  });

  it("rejects ids that are not lowercase slug ids", () => {
    const draft = { ...validDraft(), id: "Checkout_1" };
    expect(validateProjectDraft(draft, []).id).toContain("lowercase");
  });

  it("rejects an id already used by another uber-project", () => {
    expect(validateProjectDraft(validDraft(), ["checkout"]).id).toContain("already exists");
  });

  it("reports per-repo problems without dropping the good rows", () => {
    const draft = {
      ...validDraft(),
      repos: [
        { ...emptyRepoDraft("a"), id: "frontend", sourcePath: "" },
        { ...emptyRepoDraft("b"), id: "frontend", sourcePath: "/src/other" },
      ],
    };
    const errors = validateProjectDraft(draft, []);
    expect(errors.repoErrors.a?.sourcePath).toContain("required");
    expect(errors.repoErrors.a?.id).toBeUndefined();
    expect(errors.repoErrors.b?.id).toContain("Duplicate");
  });

  it("requires an absolute root override when one is given", () => {
    expect(
      validateProjectDraft({ ...validDraft(), virtualRootBase: "relative" }, []).virtualRootBase,
    ).toBeDefined();
    expect(
      validateProjectDraft({ ...validDraft(), virtualRootBase: "/abs" }, []).virtualRootBase,
    ).toBeUndefined();
  });
});

describe("projectFromDraft", () => {
  it("applies documented defaults for blank optional fields", () => {
    const draft = {
      ...emptyProjectDraft(),
      id: "checkout",
      displayName: "  Checkout  ",
      agentsTemplatePath: " /templates/agents.md ",
      repos: [{ ...emptyRepoDraft("a"), id: " frontend ", sourcePath: " /src/frontend " }],
    };
    expect(projectFromDraft(draft)).toEqual({
      id: "checkout",
      displayName: "Checkout",
      branchTemplate: DEFAULT_BRANCH_TEMPLATE,
      rootDirTemplate: DEFAULT_ROOT_DIR_TEMPLATE,
      agentsTemplatePath: "/templates/agents.md",
      repos: [
        {
          id: "frontend",
          sourcePath: "/src/frontend",
          dirTemplate: DEFAULT_REPO_DIR_TEMPLATE,
        },
      ],
    });
  });

  it("omits blank optional fields instead of persisting empty strings", () => {
    const saved = projectFromDraft({
      ...validDraft(),
      virtualRootBase: "   ",
      repos: [{ ...emptyRepoDraft("a"), id: "app", sourcePath: "/src/app", baseBranch: " " }],
    });
    expect(saved.virtualRootBase).toBeUndefined();
    expect(saved.repos[0]?.baseBranch).toBeUndefined();
  });
});

describe("previewProjectDraft", () => {
  it("renders branch, root, and per-repo folder names", () => {
    expect(previewProjectDraft(validDraft(), "feature-a")).toEqual({
      branch: "feat-feature-a",
      rootDir: "checkout-feature-a",
      repos: [
        { id: "frontend", dir: "frontend_feat-feature-a" },
        { id: "app", dir: "app-feature-a" },
      ],
    });
  });

  it("falls back to placeholders while the form is still blank", () => {
    const draft = {
      ...emptyProjectDraft(),
      repos: [{ ...emptyRepoDraft("a"), sourcePath: "/src/app" }],
    };
    expect(previewProjectDraft(draft, "feature-a")).toEqual({
      branch: "feature-a",
      rootDir: "uber-project-feature-a",
      repos: [{ id: "repo-1", dir: "repo-1_feature-a" }],
    });
  });
});

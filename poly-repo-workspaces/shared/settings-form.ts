import type { UberProject } from "./config";
import { renderBranchName, renderConstituentDirName, renderRootDirName } from "./names";

export const DEFAULT_BRANCH_TEMPLATE = "{feature}";
export const DEFAULT_ROOT_DIR_TEMPLATE = "{uberProject}-{feature}";
export const DEFAULT_REPO_DIR_TEMPLATE = "{repo}_{branch}";
export const PREVIEW_FEATURE = "feature-a";
export const MAX_ID_LENGTH = 64;

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Editable repo row. `key` is a stable React key, never persisted. */
export interface RepoDraft {
  readonly key: string;
  readonly id: string;
  readonly sourcePath: string;
  readonly dirTemplate: string;
  readonly baseBranch: string;
}

/** Editable uber-project form state. Blank optional fields fall back to defaults on save. */
export interface ProjectDraft {
  readonly id: string;
  readonly displayName: string;
  readonly branchTemplate: string;
  readonly rootDirTemplate: string;
  readonly agentsTemplatePath: string;
  readonly virtualRootBase: string;
  readonly repos: readonly RepoDraft[];
}

export interface RepoDraftErrors {
  readonly id?: string;
  readonly sourcePath?: string;
}

export interface ProjectDraftErrors {
  readonly id?: string;
  readonly displayName?: string;
  readonly agentsTemplatePath?: string;
  readonly virtualRootBase?: string;
  readonly repos?: string;
  readonly repoErrors: Readonly<Record<string, RepoDraftErrors>>;
}

export interface ProjectPreview {
  readonly branch: string;
  readonly rootDir: string;
  readonly repos: readonly { readonly id: string; readonly dir: string }[];
}

export function emptyRepoDraft(key: string): RepoDraft {
  return { key, id: "", sourcePath: "", dirTemplate: "", baseBranch: "" };
}

export function emptyProjectDraft(): ProjectDraft {
  return {
    id: "",
    displayName: "",
    branchTemplate: "",
    rootDirTemplate: "",
    agentsTemplatePath: "",
    virtualRootBase: "",
    repos: [],
  };
}

export function projectDraftFrom(project: UberProject, keyPrefix: string): ProjectDraft {
  return {
    id: project.id,
    displayName: project.displayName,
    branchTemplate: project.branchTemplate,
    rootDirTemplate: project.rootDirTemplate,
    agentsTemplatePath: project.agentsTemplatePath,
    virtualRootBase: project.virtualRootBase ?? "",
    repos: project.repos.map((repo, index) => ({
      key: `${keyPrefix}-${index}`,
      id: repo.id,
      sourcePath: repo.sourcePath,
      dirTemplate: repo.dirTemplate,
      baseBranch: repo.baseBranch ?? "",
    })),
  };
}

function validateId(value: string, what: string): string | null {
  const id = value.trim();
  if (id.length === 0) return `${what} is required.`;
  if (id.length > MAX_ID_LENGTH) return `${what} must be ${MAX_ID_LENGTH} characters or fewer.`;
  if (!ID_PATTERN.test(id)) {
    return `${what} must use lowercase letters, numbers, or hyphens, and start with a letter.`;
  }
  return null;
}

/**
 * Field-level validation for the project form. `takenIds` lists ids already used by
 * other uber-projects; pass an empty list when editing an existing project's own id.
 */
export function validateProjectDraft(
  draft: ProjectDraft,
  takenIds: readonly string[],
): ProjectDraftErrors {
  const trimmedId = draft.id.trim();
  const idProblem = validateId(draft.id, "Id");
  let id = idProblem ?? undefined;
  if (!idProblem && takenIds.includes(trimmedId)) {
    id = `An uber-project with the id "${trimmedId}" already exists.`;
  }

  const displayName = draft.displayName.trim();
  const agentsTemplatePath = draft.agentsTemplatePath.trim();
  const virtualRootBase = draft.virtualRootBase.trim();

  const repoErrors: Record<string, RepoDraftErrors> = {};
  const seenRepoIds = new Set<string>();
  for (const repo of draft.repos) {
    const repoId = repo.id.trim();
    const sourcePath = repo.sourcePath.trim();
    const idProblemForRepo = validateId(repo.id, "Repository id");
    const duplicate = !idProblemForRepo && seenRepoIds.has(repoId);
    if (repoId.length > 0) seenRepoIds.add(repoId);
    const repoProblem =
      idProblemForRepo ?? (duplicate ? `Duplicate repository id "${repoId}".` : undefined);
    const pathProblem = sourcePath.length === 0 ? "Source path is required." : undefined;
    if (repoProblem || pathProblem) {
      repoErrors[repo.key] = {
        ...(repoProblem ? { id: repoProblem } : {}),
        ...(pathProblem ? { sourcePath: pathProblem } : {}),
      };
    }
  }

  const reposProblem =
    draft.repos.length === 0
      ? "Add at least one repository."
      : draft.repos.length > 32
        ? "An uber-project supports at most 32 repositories."
        : undefined;

  const rootProblem =
    virtualRootBase.length > 0 && !virtualRootBase.startsWith("/")
      ? "Use an absolute path, or leave empty to inherit the default root."
      : undefined;

  return {
    ...(id ? { id } : {}),
    ...(displayName.length === 0 ? { displayName: "Display name is required." } : {}),
    ...(agentsTemplatePath.length === 0
      ? { agentsTemplatePath: "Choose the AGENTS.md template file." }
      : {}),
    ...(rootProblem ? { virtualRootBase: rootProblem } : {}),
    ...(reposProblem ? { repos: reposProblem } : {}),
    repoErrors,
  };
}

export function hasProjectErrors(errors: ProjectDraftErrors): boolean {
  return (
    errors.id !== undefined ||
    errors.displayName !== undefined ||
    errors.agentsTemplatePath !== undefined ||
    errors.virtualRootBase !== undefined ||
    errors.repos !== undefined ||
    Object.keys(errors.repoErrors).length > 0
  );
}

/** Build the persisted uber-project from a validated draft, applying documented defaults. */
export function projectFromDraft(draft: ProjectDraft): UberProject {
  const virtualRootBase = draft.virtualRootBase.trim();
  return {
    id: draft.id.trim(),
    displayName: draft.displayName.trim(),
    branchTemplate: draft.branchTemplate.trim() || DEFAULT_BRANCH_TEMPLATE,
    rootDirTemplate: draft.rootDirTemplate.trim() || DEFAULT_ROOT_DIR_TEMPLATE,
    agentsTemplatePath: draft.agentsTemplatePath.trim(),
    repos: draft.repos.map((repo) => {
      const baseBranch = repo.baseBranch.trim();
      return {
        id: repo.id.trim(),
        sourcePath: repo.sourcePath.trim(),
        dirTemplate: repo.dirTemplate.trim() || DEFAULT_REPO_DIR_TEMPLATE,
        ...(baseBranch.length > 0 ? { baseBranch } : {}),
      };
    }),
    ...(virtualRootBase.length > 0 ? { virtualRootBase } : {}),
  };
}

/** Rendered branch and folder names a workspace would get from this draft. */
export function previewProjectDraft(draft: ProjectDraft, feature: string): ProjectPreview {
  const uberProjectId = draft.id.trim().length > 0 ? draft.id.trim() : "uber-project";
  const branchTemplate = draft.branchTemplate.trim() || DEFAULT_BRANCH_TEMPLATE;
  const rootDirTemplate = draft.rootDirTemplate.trim() || DEFAULT_ROOT_DIR_TEMPLATE;
  const branch = renderBranchName(branchTemplate, { uberProjectId, feature });
  const rootDir = renderRootDirName(rootDirTemplate, {
    uberProjectId,
    feature,
    branch,
  });
  return {
    branch,
    rootDir,
    repos: draft.repos.map((repo, index) => {
      const repoId = repo.id.trim().length > 0 ? repo.id.trim() : `repo-${index + 1}`;
      return {
        id: repoId,
        dir: renderConstituentDirName(repo.dirTemplate.trim() || DEFAULT_REPO_DIR_TEMPLATE, {
          uberProjectId,
          feature,
          branch,
          repoId,
        }),
      };
    }),
  };
}

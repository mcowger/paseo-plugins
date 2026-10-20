export interface TemplateVars {
  uberProject: string;
  feature: string;
  branch: string;
  repo: string;
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .replaceAll("{uberProject}", vars.uberProject)
    .replaceAll("{feature}", vars.feature)
    .replaceAll("{branch}", vars.branch)
    .replaceAll("{repo}", vars.repo);
}

/** Keep existing Git-safe names stable so older workspaces can still resume. */
export function sanitizeFeatureName(feature: string): string {
  const segments = feature.split("/");
  if (
    feature.length > 0 &&
    !feature.startsWith("-") &&
    !/[\s~^:?*{}[\]\\]/.test(feature) &&
    !/[\p{Cc}\p{Cf}]/u.test(feature) &&
    feature !== "@" &&
    feature !== "HEAD" &&
    !feature.includes("..") &&
    !feature.endsWith(".") &&
    segments.every(
      (segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"),
    )
  ) {
    return feature;
  }
  const slug = feature
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "feature";
}

export function renderBranchName(
  branchTemplate: string,
  input: { uberProjectId: string; feature: string },
): string {
  const feature = sanitizeFeatureName(input.feature);
  return sanitizeFeatureName(
    renderTemplate(branchTemplate, {
      uberProject: input.uberProjectId,
      feature,
      branch: feature,
      repo: "",
    }),
  );
}

export function renderRootDirName(
  rootDirTemplate: string,
  input: { uberProjectId: string; feature: string; branch: string },
): string {
  return renderTemplate(rootDirTemplate, {
    uberProject: input.uberProjectId,
    feature: sanitizeFeatureName(input.feature),
    branch: input.branch,
    repo: "",
  });
}

export function renderConstituentDirName(
  dirTemplate: string,
  input: { uberProjectId: string; feature: string; branch: string; repoId: string },
): string {
  return renderTemplate(dirTemplate, {
    uberProject: input.uberProjectId,
    feature: sanitizeFeatureName(input.feature),
    branch: input.branch,
    repo: input.repoId,
  });
}

export function resolveRootBase(input: {
  perProject?: string;
  hostSetting?: string;
  paseoHome: string;
}): string {
  const base = input.perProject ?? input.hostSetting;
  if (base && base.length > 0) return base;
  const home = input.paseoHome.endsWith("/") ? input.paseoHome.slice(0, -1) : input.paseoHome;
  return `${home}/poly-workspaces`;
}

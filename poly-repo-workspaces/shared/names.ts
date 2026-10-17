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

export function renderBranchName(
  branchTemplate: string,
  input: { uberProjectId: string; feature: string },
): string {
  return renderTemplate(branchTemplate, {
    uberProject: input.uberProjectId,
    feature: input.feature,
    branch: input.feature,
    repo: "",
  });
}

export function renderRootDirName(
  rootDirTemplate: string,
  input: { uberProjectId: string; feature: string; branch: string },
): string {
  return renderTemplate(rootDirTemplate, {
    uberProject: input.uberProjectId,
    feature: input.feature,
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
    feature: input.feature,
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

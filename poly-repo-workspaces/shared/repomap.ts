export interface RepomapRepo {
  repoId: string;
  sourcePath: string;
  worktreePath: string;
  dirName: string;
  branch: string;
  baseBranch: string;
  topLevelEntries: string[];
  fragment: string | null;
}

export interface RepomapInput {
  uberProjectName: string;
  feature: string;
  branch: string;
  generatedAt: string;
  repos: RepomapRepo[];
}

const MAX_ENTRIES_PER_REPO = 60;
const MAX_FRAGMENT_CHARS = 4000;

export function truncateFragment(fragment: string): string {
  if (fragment.length <= MAX_FRAGMENT_CHARS) return fragment;
  return `${fragment.slice(0, MAX_FRAGMENT_CHARS)}\n\n[... truncated ...]`;
}

export function buildRepomap(input: RepomapInput): string {
  const lines: string[] = [
    `# REPOMAP: ${input.uberProjectName} / ${input.feature}`,
    "",
    `Branch: ${input.branch} (same on every repo below)`,
    `Generated: ${input.generatedAt}`,
    "",
    "Each section is a separate git checkout. Run git commands inside the",
    "listed directory, not at this root (the root is not a git repo).",
    "",
  ];
  for (const repo of input.repos) {
    lines.push(`## ${repo.repoId}`);
    lines.push("");
    lines.push(`- Directory: ${repo.dirName}`);
    lines.push(`- Branch: ${repo.branch} (from ${repo.baseBranch})`);
    const entries = repo.topLevelEntries.slice(0, MAX_ENTRIES_PER_REPO);
    if (entries.length > 0) {
      lines.push(`- Top level: ${entries.join(", ")}`);
      if (repo.topLevelEntries.length > entries.length) {
        lines.push(`  (... ${repo.topLevelEntries.length - entries.length} more entries)`);
      }
    }
    if (repo.fragment) {
      lines.push("");
      lines.push(truncateFragment(repo.fragment));
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface AgentsTemplateVars {
  uberProjectName: string;
  feature: string;
  branch: string;
  repos: Array<{ repoId: string; dirName: string }>;
}

export function renderAgentsTemplate(template: string, vars: AgentsTemplateVars): string {
  const repoList = vars.repos.map((repo) => `- ${repo.dirName}/ (${repo.repoId})`).join("\n");
  return template
    .replaceAll("{{uberProject}}", vars.uberProjectName)
    .replaceAll("{{feature}}", vars.feature)
    .replaceAll("{{branch}}", vars.branch)
    .replaceAll("{{repos}}", repoList);
}

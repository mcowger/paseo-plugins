export interface SkillCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: string;
}

interface CommandLike {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
  kind?: unknown;
}

export function isSkillCommand(command: CommandLike | null | undefined): command is SkillCommand {
  if (!command || typeof command !== "object") return false;
  return command.kind === "skill" && typeof command.name === "string" && command.name.length > 0;
}

export function filterSkills(
  commands: readonly CommandLike[] | null | undefined,
  query: string | null | undefined,
): SkillCommand[] {
  if (!Array.isArray(commands)) return [];
  const needle = (query ?? "").trim().toLowerCase();
  const skills: SkillCommand[] = [];
  for (const command of commands) {
    if (!isSkillCommand(command)) continue;
    const skill: SkillCommand = {
      name: command.name,
      description: typeof command.description === "string" ? command.description : "",
      argumentHint: typeof command.argumentHint === "string" ? command.argumentHint : "",
      kind: "skill",
    };
    if (needle.length > 0) {
      const haystack = `${skill.name} ${skill.description}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    skills.push(skill);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// Providers may namespace command names (e.g. Pi reports skills as
// "skill:opencodereview-cli" and extensions as "ext:foo"), so allow
// colon-separated segments in addition to bare names.
const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/;

export function normalizeSkillName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim().replace(/^\/+/, "");
  if (!trimmed || !SKILL_NAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function toSkillInvocation(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) throw new Error("Skill name is required");
  const normalized = normalizeSkillName(trimmed);
  if (!normalized) throw new Error(`Invalid skill name: ${trimmed}`);
  return `/${normalized}`;
}

// Strips the provider's `skill:` namespace for display so the pill reads
// `/grill-me` rather than `/skill:grill-me`; invocation still uses the full name.
export function toSkillDisplayName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim().replace(/^\/+/, "");
  return trimmed.startsWith("skill:") ? trimmed.slice("skill:".length) : trimmed;
}

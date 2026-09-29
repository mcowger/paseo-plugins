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

export function toSkillInvocation(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) throw new Error("Skill name is required");
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error(`Invalid skill name: ${trimmed}`);
  return `/${trimmed}`;
}

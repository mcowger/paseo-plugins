import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import type { SkillCommand } from "./skills";

export const MAX_TRACKED_SKILLS = 50;

const skillUsageEntrySchema = z.object({
  count: z.number().int().min(1),
  lastUsedAt: z.string().min(1),
});

export type SkillUsageEntry = z.output<typeof skillUsageEntrySchema>;

export const skillUsageSchema = z.object({
  skills: z.record(z.string(), skillUsageEntrySchema).default({}),
});

export type SkillUsage = z.output<typeof skillUsageSchema>;

export const skillUsageSettings = defineSettings({
  id: "usage",
  scope: "host",
  version: 1,
  schema: skillUsageSchema,
});

export function normalizeUsageName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim().replace(/^\/+/, "");
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function pruneSkills(skills: Record<string, SkillUsageEntry>): Record<string, SkillUsageEntry> {
  const entries = Object.entries(skills);
  if (entries.length <= MAX_TRACKED_SKILLS) return skills;
  entries.sort((a, b) => {
    const recency = timeOf(b[1].lastUsedAt) - timeOf(a[1].lastUsedAt);
    if (recency !== 0) return recency;
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const kept: Record<string, SkillUsageEntry> = {};
  for (const [name, entry] of entries.slice(0, MAX_TRACKED_SKILLS)) {
    kept[name] = entry;
  }
  return kept;
}

export function recordSkillUsage(
  values: SkillUsage | null | undefined,
  name: string | null | undefined,
  nowIso?: string,
): SkillUsage {
  const skills = { ...values?.skills };
  const key = normalizeUsageName(name);
  if (!key) return { skills };
  const now = nowIso ?? new Date().toISOString();
  const previous = skills[key];
  skills[key] = { count: (previous?.count ?? 0) + 1, lastUsedAt: now };
  return { skills: pruneSkills(skills) };
}

export function sortSkillsByUsage(
  skills: readonly SkillCommand[],
  usage: SkillUsage | null | undefined,
): SkillCommand[] {
  const tracked = usage?.skills ?? {};
  return [...skills].sort((a, b) => {
    const entryA = tracked[a.name];
    const entryB = tracked[b.name];
    if (entryA && entryB) {
      const recency = timeOf(entryB.lastUsedAt) - timeOf(entryA.lastUsedAt);
      if (recency !== 0) return recency;
      if (entryB.count !== entryA.count) return entryB.count - entryA.count;
      return a.name.localeCompare(b.name);
    }
    if (entryA) return -1;
    if (entryB) return 1;
    return a.name.localeCompare(b.name);
  });
}

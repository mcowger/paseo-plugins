import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const paletteModeSchema = z.enum(["vivid", "soft", "high_contrast"]);
export type PaletteMode = z.output<typeof paletteModeSchema>;

export const expansionModeSchema = z.enum(["always", "latest", "never"]);
export type ExpansionMode = z.output<typeof expansionModeSchema>;

/**
 * One expansion knob per collapsible row renderer. Defaults reproduce the
 * historical behavior: reads and questions start collapsed, task lists start
 * open, everything else opens only for the latest row.
 */
export const EXPANSION_TARGETS = [
  { key: "thinking", label: "Thinking", default: "latest" },
  { key: "read", label: "Read file", default: "never" },
  { key: "edit", label: "Edit file", default: "latest" },
  { key: "write", label: "Write file", default: "latest" },
  { key: "shell", label: "Shell", default: "latest" },
  { key: "search", label: "Search", default: "latest" },
  { key: "fetch", label: "Web fetch", default: "latest" },
  { key: "worktree_setup", label: "Worktree setup", default: "latest" },
  { key: "sub_agent", label: "Subagents", default: "latest" },
  { key: "plain_text", label: "Plain text", default: "latest" },
  { key: "plan", label: "Plans", default: "latest" },
  { key: "ask", label: "Ask Question", default: "never" },
  { key: "speak", label: "Speak", default: "latest" },
  { key: "todo", label: "Tasks", default: "always" },
  { key: "unknown", label: "Unknown tools", default: "latest" },
] as const satisfies readonly { key: string; label: string; default: ExpansionMode }[];

export type ExpansionTarget = (typeof EXPANSION_TARGETS)[number]["key"];

export const DEFAULT_EXPANSION: Record<ExpansionTarget, ExpansionMode> = {
  thinking: "latest",
  read: "never",
  edit: "latest",
  write: "latest",
  shell: "latest",
  search: "latest",
  fetch: "latest",
  worktree_setup: "latest",
  sub_agent: "latest",
  plain_text: "latest",
  plan: "latest",
  ask: "never",
  speak: "latest",
  todo: "always",
  unknown: "latest",
};

const expansionSettingsSchema = z.object({
  thinking: expansionModeSchema.default("latest"),
  read: expansionModeSchema.default("never"),
  edit: expansionModeSchema.default("latest"),
  write: expansionModeSchema.default("latest"),
  shell: expansionModeSchema.default("latest"),
  search: expansionModeSchema.default("latest"),
  fetch: expansionModeSchema.default("latest"),
  worktree_setup: expansionModeSchema.default("latest"),
  sub_agent: expansionModeSchema.default("latest"),
  plain_text: expansionModeSchema.default("latest"),
  plan: expansionModeSchema.default("latest"),
  ask: expansionModeSchema.default("never"),
  speak: expansionModeSchema.default("latest"),
  todo: expansionModeSchema.default("always"),
  unknown: expansionModeSchema.default("latest"),
});

export const activitySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    palette: paletteModeSchema.default("vivid"),
    expansion: expansionSettingsSchema.default(DEFAULT_EXPANSION),
  }),
});

export const DEFAULT_PALETTE_MODE: PaletteMode = "vivid";

import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const paletteModeSchema = z.enum(["vivid", "soft", "high_contrast"]);
export type PaletteMode = z.output<typeof paletteModeSchema>;

/**
 * How far completed rows step back. Running, failed, hovered, and expanded rows
 * always render at full strength, so quieting never hides active work.
 */
export const quietStrengthSchema = z.enum(["dim", "faded", "soft", "full"]);
export type QuietStrength = z.output<typeof quietStrengthSchema>;

/** When the shell command in a row summary is syntax colored. */
export const commandColorSchema = z.enum(["expanded", "always", "off"]);
export type CommandColor = z.output<typeof commandColorSchema>;

/** How a code or command block is framed: label bar, nothing, or a line-number gutter. */
export const codeChromeSchema = z.enum(["header", "bare", "gutter"]);
export type CodeChrome = z.output<typeof codeChromeSchema>;

/** Wrap long diff and code lines, or keep them on one line with horizontal scrolling. */
export const diffWrapSchema = z.enum(["on", "off"]);
export type DiffWrap = z.output<typeof diffWrapSchema>;

/** Restyle the host's own reply markdown (inline code, fenced blocks). Desktop and web only. */
export const replyCodeSchema = z.enum(["on", "off"]);
export type ReplyCode = z.output<typeof replyCodeSchema>;

export const expansionModeSchema = z.enum(["always", "latest", "never"]);
export type ExpansionMode = z.output<typeof expansionModeSchema>;

/**
 * How many lines of a long block render before its "Show all" control appears.
 * `0` shows the whole block: the expander is the only escape hatch otherwise.
 */
export const previewLinesSchema = z.number().int().min(0).max(2_000);
export const thinkingLinesSchema = z.number().int().min(0).max(20_000);

/**
 * One expansion knob per collapsible row renderer. Defaults keep reads and
 * questions collapsed and open the newest task update and activity row.
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
  { key: "todo", label: "Tasks", default: "latest" },
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
  todo: "latest",
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
  todo: expansionModeSchema.default("latest"),
  unknown: expansionModeSchema.default("latest"),
});

export const activitySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 3,
  // v1 stored only the palette and row expansion; v2 added the display knobs; v3
  // added the block-length limits. Every key has a default, so passing older
  // values through the current schema fills the missing ones in.
  migrate: (values) => values,
  schema: z.object({
    palette: paletteModeSchema.default("vivid"),
    expansion: expansionSettingsSchema.default(DEFAULT_EXPANSION),
    quiet: quietStrengthSchema.default("faded"),
    commandColor: commandColorSchema.default("expanded"),
    codeChrome: codeChromeSchema.default("header"),
    diffWrap: diffWrapSchema.default("off"),
    replyCode: replyCodeSchema.default("on"),
    // File contents, diffs, and JSON payloads: 20 lines is the historical cap.
    previewLines: previewLinesSchema.default(20),
    // Thinking is the main reading surface, so its default matches the old 32,000
    // character cap it used to carry: plenty for a real block, finite for a runaway one.
    thinkingLines: thinkingLinesSchema.default(400),
  }),
});

export type ActivitySettings = z.output<typeof activitySettings.schema>;

/** What every renderer reads when nothing is stored yet or the read failed. */
export const DEFAULT_ACTIVITY_SETTINGS: ActivitySettings = activitySettings.schema.parse({});

export const DEFAULT_PALETTE_MODE: PaletteMode = DEFAULT_ACTIVITY_SETTINGS.palette;

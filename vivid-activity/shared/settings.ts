import { t } from "./text";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_LINE_SPACING, DEFAULT_TEXT_SIZE, LINE_SPACINGS, MONO_FONT_MAX, TEXT_SIZES } from "./typography";

export const paletteModeSchema = z.enum(["vivid", "soft", "high_contrast", "theme"]);
export type PaletteMode = z.output<typeof paletteModeSchema>;

export const expansionModeSchema = z.enum(["always", "latest", "never", "failures"]);
export type ExpansionMode = z.output<typeof expansionModeSchema>;

/**
 * 本地补丁：接管范围。全部 = 思考行和工具行都由本插件绘制；仅思考行 = 工具行交还 Paseo；
 * 关闭 = 两者都交还 Paseo（插件保持安装，可随时打开）。计划卡、任务行、审批卡始终由 Paseo 显示。
 */
export const takeoverScopeSchema = z.enum(["all", "reasoning", "off"]);
export type TakeoverScope = z.output<typeof takeoverScopeSchema>;
export const DEFAULT_TAKEOVER: TakeoverScope = "all";

/**
 * One expansion knob per collapsible row renderer. 本地默认：读取、编辑、写入、命令和提问默认收起，
 * 其余只展开最新一行。`hidden` 的项仍在存储结构里，但对应的行已交还 Paseo，设置页不再列出。
 */
export const EXPANSION_TARGETS = [
  { key: "thinking", get label() { return t("ui.thinking"); }, default: "latest" },
  { key: "read", get label() { return t("settings.readFile"); }, default: "never" },
  { key: "edit", get label() { return t("settings.editFile"); }, default: "never" },
  { key: "write", get label() { return t("settings.writeFile"); }, default: "never" },
  { key: "shell", get label() { return t("ui.command"); }, default: "never" },
  { key: "search", get label() { return t("settings.search"); }, default: "latest" },
  { key: "fetch", get label() { return t("settings.fetchPage"); }, default: "latest" },
  { key: "worktree_setup", get label() { return t("settings.worktreeSetup"); }, default: "latest" },
  { key: "sub_agent", get label() { return t("settings.subagent"); }, default: "latest" },
  { key: "plain_text", get label() { return t("settings.plainTextResults"); }, default: "latest" },
  { key: "plan", get label() { return t("settings.plan"); }, default: "latest", hidden: true },
  { key: "ask", get label() { return t("settings.ask"); }, default: "never" },
  { key: "speak", get label() { return t("settings.readAloud"); }, default: "latest" },
  { key: "todo", get label() { return t("settings.taskListTools"); }, default: "latest" },
  { key: "browser", get label() { return t("settings.browserTools"); }, default: "latest" },
  { key: "unknown", get label() { return t("settings.otherTools"); }, default: "latest" },
] as const satisfies readonly { key: string; label: string; default: ExpansionMode; hidden?: boolean }[];

export type ExpansionTarget = (typeof EXPANSION_TARGETS)[number]["key"];

export const DEFAULT_EXPANSION = Object.fromEntries(
  EXPANSION_TARGETS.map((target) => [target.key, target.default]),
) as Record<ExpansionTarget, ExpansionMode>;

/** Targets the settings screen lists; thinking only when tool rows are not taken over. */
export function visibleExpansionTargets(scope: TakeoverScope) {
  return EXPANSION_TARGETS.filter(
    (target) => !("hidden" in target && target.hidden) && (scope === "all" || target.key === "thinking"),
  );
}

const expansionSettingsSchema = z.object(
  Object.fromEntries(
    EXPANSION_TARGETS.map((target) => [target.key, expansionModeSchema.default(target.default)]),
  ) as Record<ExpansionTarget, z.ZodDefault<typeof expansionModeSchema>>,
);

/**
 * 本地补丁：行密度。紧凑 = 行更矮、上下留白更少，并用负外边距抵掉 Paseo 给每条插件行加的 16px 间距（行间只剩 4px）；
 * 标准 = 0.3.0-local.1 的行高和间距。
 */
export const densitySchema = z.enum(["compact", "standard"]);
export type Density = z.output<typeof densitySchema>;
export const DEFAULT_DENSITY: Density = "compact";
export const DEFAULT_FOLD = true;

/**
 * 0.11.0: 「淡出强度」, how far a finished row steps back until you hover, focus or expand it. Running, waiting,
 * asking and live-tail rows always sit at full strength, as do rows with nothing to expand. Finished fold
 * summaries fade too; expanding or hovering one restores it, and a running segment's header stays full
 * (shared: client/activity.tsx, client/fold-row.tsx).
 */
export const STRENGTH_KINDS = ["dim", "faded", "soft", "full"] as const;
export type Strength = (typeof STRENGTH_KINDS)[number];
export const DEFAULT_STRENGTH: Strength = "full";
export const strengthSchema = z.enum(STRENGTH_KINDS);

/** 0.11.0:「命令着色」档位（client/activity.tsx 行头段；设置页 settings.tsx 消费）。 */
export const commandColorsSchema = z.enum(["expanded", "always"]);

/** 淡出强度档位 → 行的不透明度（activity/fold-row/preview-card 共用）。 */
export const STRENGTH_OPACITY: Record<Strength, number> = { dim: 0.3, faded: 0.45, soft: 0.65, full: 1 };
/** 0.6.0: 「钉住本轮提问」 (shared/prompt-pin.ts). */
export const DEFAULT_PIN_PROMPT = true;

/**
 * 0.8.0: 「运行中动画」, the mark at the end of a running row: the spinner (default, the observatory's running mark too),
 * or one of the animations in shared/loaders.ts, drawn by the lazy fx chunk.
 */
export const LOADER_KINDS = ["spinner", "sparkle", "orb", "snake", "matrix"] as const;
export type LoaderKind = (typeof LOADER_KINDS)[number];
export const DEFAULT_LOADER: LoaderKind = "spinner";
export const loaderSchema = z.enum(LOADER_KINDS);

// 版本号保持 1：0.11.0 的新字段都有默认值，0.10.x 及更早的 v1 存档按本 schema 原样解析。宿主（Paseo ≥0.11.1
// packages/server/src/server/plugins/settings）遇到存档版本 ≠ 定义版本且无 migrate 时读出 invalid、保存被拒，
// 所以不能只升版本号（shared/settings.test.ts 按宿主的版本信封检查回归）。0.11.0 预发布构建里的 diffWrap 不迁移
// （z.object 剥离未知键，取默认）。
export const activitySettings = defineSettings({
  id: "display",
  scope: "host",
  // 保持 1，见上。
  version: 1,
  schema: z.object({
    takeover: takeoverScopeSchema.default(DEFAULT_TAKEOVER),
    // 0.11.0：左侧边栏入口开关。关 = 移除设置入口（命令面板入口不受影响）；旧设置没有这一项，读出来取默认值。
    sidebar: z.boolean().default(true),
    // 0.11.0：跟随矩阵（思考行走 thoughtTailFollow，尾窗窗口语义独立）。按展开区域逐域开关。
    followOutput: z
      .object({
        shell: z.boolean().default(true),
        logs: z.boolean().default(true),
        todo: z.boolean().default(true),
        browser: z.boolean().default(true),
      })
      .default({ shell: true, logs: true, todo: true, browser: true }),
    // 0.11.0：长行折行矩阵（预发布的 diffWrap 扩围，不迁移；旧设置读出来取默认值）。off = 单行横滚（0.11.0 前的现状）。
    wrapLines: z
      .object({
        diff: z.boolean().default(false),
        code: z.boolean().default(false),
        output: z.boolean().default(false),
      })
      .default({ diff: false, code: false, output: false }),
    palette: paletteModeSchema.default("vivid"),
    expansion: expansionSettingsSchema.default(DEFAULT_EXPANSION),
    // 本地补丁：「完成后折叠连续的思考与工具行」。旧设置没有这两项，读出来取默认值，所以版本号不变。
    fold: z.boolean().default(DEFAULT_FOLD),
    density: densitySchema.default(DEFAULT_DENSITY),
    // 0.11.0：同上，旧设置读出来取默认值。
    strength: strengthSchema.default(DEFAULT_STRENGTH),
    // 0.11.0：「命令着色」行头 shell 命令的语法色（client/activity.tsx 行头段；chat-polish 同名设置）。
    commandColors: commandColorsSchema.default("expanded"),
    // 0.11.0：「思考行实时跟随」：开 = 展开后的思考框展示最新 N 行并跟随输出；关 = 头部 20 行冻结（现状）。
    thoughtTailFollow: z.boolean().default(false),
    // 0.11.0：尾窗大小（块模式=行数，步骤模式=步数）。UI 层钳制 5–500 后才保存。
    thoughtTailLines: z.number().int().min(5).max(500).default(20),
    // 「每轮结束时间」（server/turn-time.ts 记录新轮次）与「活动时间」（活动行/折叠摘要的更新时间）。默认关；
    // 旧设置没有这两项，读出来取默认值，所以版本号不变。
    turnTime: z.boolean().default(false),
    foldTime: z.boolean().default(false),
    // 0.6.0：同上，旧设置没有这一项，读出来取默认值。
    pinPrompt: z.boolean().default(DEFAULT_PIN_PROMPT),
    // 0.8.0：同上。
    loader: loaderSchema.default(DEFAULT_LOADER),
    // 0.9.0（issue #3）：代码字体（shared/typography.ts）。同上，旧设置读出来取默认值。
    monoFont: z.string().max(MONO_FONT_MAX).default(""),
    textSize: z.enum(TEXT_SIZES).default(DEFAULT_TEXT_SIZE),
    lineSpacing: z.enum(LINE_SPACINGS).default(DEFAULT_LINE_SPACING),
  }),
});

export const DEFAULT_PALETTE_MODE: PaletteMode = "vivid";

/** The stored takeover scope, or null when the stored values do not parse. */
export function takeoverFromValues(values: unknown): TakeoverScope | null {
  const parsed = activitySettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data.takeover : null;
}

export function turnTimeFromValues(values: unknown): boolean {
  const parsed = activitySettings.schema.safeParse(values ?? {});
  return parsed.success ? parsed.data.turnTime : false;
}

/** The stored folding switch and takeover scope, or null when the stored values do not parse. */
export function foldFromValues(values: unknown): { enabled: boolean; scope: TakeoverScope } | null {
  const parsed = activitySettings.schema.safeParse(values ?? {});
  return parsed.success ? { enabled: parsed.data.fold, scope: parsed.data.takeover } : null;
}

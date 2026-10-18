import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { alpha, sunken } from "../../shared/color";
import {
  type ActivitySettings,
  BLOCK_HEIGHT_KINDS,
  type BlockHeightKind,
  type CodeChrome,
  type CommandColor,
  DEFAULT_EXPANSION,
  EXPANSION_TARGETS,
  type ExpansionTarget,
  type QuietStrength,
  type ReplyCode,
} from "../../shared/settings";
import { type ActivityPalette, type ActivityThemeColors, resolveActivityPalette } from "../../shared/presentation";
import { quietOpacity } from "../prefs";
import {
  ActionButton,
  CompactRow,
  ControlRow,
  Group,
  Note,
  Segmented,
  Tile,
  useDashboardStyles,
} from "./controls";

export interface PageProps {
  prefs: ActivitySettings;
  change: (patch: Partial<ActivitySettings>) => void;
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
}

const PALETTES: { value: ActivitySettings["palette"]; name: string; hint: string }[] = [
  { value: "vivid", name: "Vivid", hint: "Restrained category accents on neutral rows." },
  { value: "soft", name: "Soft", hint: "Mostly neutral icons, with color kept for status." },
  {
    value: "high_contrast",
    name: "High contrast",
    hint: "Stronger dividers and status colors for scanning.",
  },
];

const QUIET: { value: QuietStrength; name: string }[] = [
  { value: "dim", name: "Dim" },
  { value: "faded", name: "Faded" },
  { value: "soft", name: "Soft" },
  { value: "full", name: "Full strength" },
];

const CHROME: { value: CodeChrome; name: string; hint: string }[] = [
  { value: "header", name: "Header bar", hint: "Language and copy inside the card." },
  { value: "bare", name: "Bare", hint: "Label above the card, nothing inside." },
  { value: "gutter", name: "Header + gutter", hint: "Line numbers in a muted column." },
];

const COMMANDS: { value: CommandColor; name: string; hint: string }[] = [
  { value: "expanded", name: "When expanded", hint: "Collapsed rows keep a quiet summary." },
  { value: "always", name: "Always", hint: "Color the command in every row." },
  { value: "off", name: "Never", hint: "Plain monospace commands." },
];

type Expansion = ActivitySettings["expansion"];
type ExpansionMode = Expansion[ExpansionTarget];

const expansionPreset = (value: ExpansionMode, except: Partial<Expansion> = {}): Expansion =>
  Object.fromEntries(
    EXPANSION_TARGETS.map((target) => [target.key, except[target.key] ?? value]),
  ) as Expansion;

const PRESETS: { id: string; label: string; expansion: Expansion }[] = [
  {
    id: "newest",
    label: "Newest only",
    expansion: expansionPreset("latest", { read: "never", ask: "never" }),
  },
  { id: "all", label: "Everything open", expansion: expansionPreset("always") },
  { id: "none", label: "Everything collapsed", expansion: expansionPreset("never") },
];

/**
 * Block heights in pixels, as pickable steps. `0` is "All": the block never gets its
 * own window and the timeline scrolls instead.
 */
/**
 * Rows the daemon and the providers raise rather than you: worth a line of prose,
 * because the label alone says nothing about where the row came from.
 */
const ROW_HINTS: Partial<Record<ExpansionTarget, string>> = {
  worktree_setup:
    "Paseo's own worktree setup: the commands it ran when this workspace was created.",
  plain_text: "A provider tool with nothing but text to show — a label and a message.",
  plan: "A plan a provider proposed, not a tool call with input and output.",
  sub_agent: "Rows for child agents and the tasks they were given.",
  unknown: "Any tool with no shape the row renderer recognizes.",
};

/** The rows a session raises constantly, and the ones it raises occasionally. */
const COMMON_ROWS: ExpansionTarget[] = [
  "thinking",
  "read",
  "edit",
  "write",
  "shell",
  "search",
  "fetch",
  "sub_agent",
  "todo",
];
const RARE_ROWS: ExpansionTarget[] = [
  "worktree_setup",
  "plain_text",
  "plan",
  "ask",
  "speak",
  "unknown",
];

const BLOCK_HEIGHT_LABELS: Record<BlockHeightKind, string> = {
  thinking: "Thinking",
  read: "Read",
  shell: "Shell",
  write: "Write",
  edit: "Edit",
};

const BLOCK_HEIGHT_HINTS: Record<BlockHeightKind, string> = {
  thinking: "Streams to its end, so the newest lines are the ones in view.",
  read: "A file's contents, scrolled from its start.",
  shell: "Command output, scrolled from its end.",
  write: "A new file's contents.",
  edit: "Diffs, which are read line by line against each other.",
};

const BLOCK_HEIGHT_OPTIONS: { value: number; label: string }[] = [
  { value: 200, label: "200" },
  { value: 320, label: "320" },
  { value: 420, label: "420" },
  { value: 600, label: "600" },
  { value: 900, label: "900" },
  { value: 0, label: "All" },
];

/** A value the picker does not carry still has to show up, or the row looks unset. */
function withCurrent(
  options: { value: number; label: string }[],
  current: number,
): { value: number; label: string }[] {
  if (options.some((option) => option.value === current)) return options;
  return [
    ...options.slice(0, -1),
    { value: current, label: current.toLocaleString() },
    ...options.slice(-1),
  ];
}

/**
 * A miniature activity row: category dot, label, muted summary, status dot, and
 * the guide that the palette controls. The divider is the point: soft draws it
 * faint and thin, vivid at the normal weight, high contrast bright and doubled.
 */
function MiniRow({
  palette,
  styles,
  quiet = 1,
  divider = false,
}: {
  palette: ActivityPalette;
  styles: ReturnType<typeof useDashboardStyles>;
  quiet?: number;
  divider?: boolean;
}) {
  return (
    <View style={{ gap: 6, opacity: quiet }}>
      <View style={{ alignItems: "center", flexDirection: "row", gap: 6 }}>
        <View
          style={{
            backgroundColor: palette.categoryColors.file,
            borderRadius: 3,
            height: 11,
            width: 11,
          }}
        />
        <View
          style={{
            backgroundColor: styles.colors.foreground,
            borderRadius: 2,
            height: 6,
            opacity: 0.85,
            width: 40,
          }}
        />
        <View
          style={{
            backgroundColor: styles.colors.foregroundMuted,
            borderRadius: 2,
            flex: 1,
            height: 6,
            minWidth: 10,
            opacity: 0.7,
          }}
        />
        <View
          style={{
            backgroundColor: palette.statusColors.completed,
            borderRadius: 3,
            height: 7,
            width: 7,
          }}
        />
      </View>
      {divider ? (
        <View
          style={{
            backgroundColor: alpha(styles.colors.border, palette.railAlpha),
            height: palette.borderWidth,
            width: "100%",
          }}
        />
      ) : null}
    </View>
  );
}

function ActivityPage({ prefs, change, theme }: PageProps) {
  const styles = useDashboardStyles(theme);
  const activityColors = theme.colors as ActivityThemeColors;
  return (
    <View style={{ gap: 24 }}>
      <Group
        title="Palette"
        hint="How much color activity rows spend. Layout and density never change."
        styles={styles}
      >
        <View accessibilityRole="radiogroup" style={styles.tiles}>
          {PALETTES.map((option) => (
            <Tile
              key={option.value}
              name={option.name}
              selected={prefs.palette === option.value}
              onPress={() => change({ palette: option.value })}
              styles={styles}
            >
              <MiniRow
                divider
                palette={resolveActivityPalette(option.value, activityColors)}
                styles={styles}
              />
            </Tile>
          ))}
        </View>
        <Text style={styles.hint}>
          {PALETTES.find((option) => option.value === prefs.palette)?.hint}
        </Text>
      </Group>
      <Group
        title="Quiet rows"
        hint="Finished rows step back so the newest work stands out. Running, failed, hovered, and expanded rows stay at full strength."
        styles={styles}
      >
        <View accessibilityRole="radiogroup" style={styles.tiles}>
          {QUIET.map((option) => (
            <Tile
              key={option.value}
              name={option.name}
              selected={prefs.quiet === option.value}
              onPress={() => change({ quiet: option.value })}
              styles={styles}
            >
              <MiniRow
                palette={resolveActivityPalette(prefs.palette, activityColors)}
                styles={styles}
                quiet={quietOpacity(option.value)}
              />
            </Tile>
          ))}
        </View>
      </Group>
    </View>
  );
}

const EXPANSION_MODES = [
  { value: "always" as const, label: "Always" },
  { value: "latest" as const, label: "Latest" },
  { value: "never" as const, label: "Never" },
];

const ROW_LABELS = new Map(EXPANSION_TARGETS.map((target) => [target.key, target.label]));

function labelFor(key: ExpansionTarget): string {
  return ROW_LABELS.get(key) ?? key;
}

function RowsPage({ prefs, change, theme, layout }: PageProps) {
  const styles = useDashboardStyles(theme);
  const stacked = layout.compact;
  const modeFor = (key: ExpansionTarget) => prefs.expansion[key] ?? DEFAULT_EXPANSION[key];
  return (
    <View style={{ gap: 24 }}>
      <Group
        title="Presets"
        hint="Replace every row's start state at once; individual rows stay adjustable below."
        styles={styles}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {PRESETS.map((preset) => (
            <ActionButton
              key={preset.id}
              label={preset.label}
              icon="Wand2"
              onPress={() => change({ expansion: preset.expansion })}
              styles={styles}
            />
          ))}
        </View>
      </Group>
      {[
        {
          title: "Row expansion",
          hint: "Always starts expanded, Latest opens only while the row is newest, Never stays collapsed until tapped.",
          keys: COMMON_ROWS,
        },
        {
          title: "Provider and daemon rows",
          hint: "Rows nothing you typed produced. Same three choices, explained because the names are not yours.",
          keys: RARE_ROWS,
        },
      ].map((group) => (
        <Group key={group.title} title={group.title} hint={group.hint} styles={styles}>
          <View>
            {group.keys.map((key, index) => {
              const mode = modeFor(key);
              return (
                <CompactRow
                  key={key}
                  label={labelFor(key)}
                  hint={ROW_HINTS[key]}
                  styles={styles}
                  stacked={stacked}
                  first={index === 0}
                >
                  <Segmented
                    accessibilityLabel={`${labelFor(key)} expansion`}
                    value={mode}
                    compact
                    options={EXPANSION_MODES}
                    onChange={(value) =>
                      change({ expansion: { ...prefs.expansion, [key]: value } })
                    }
                    styles={styles}
                  />
                </CompactRow>
              );
            })}
          </View>
        </Group>
      ))}
      <Group
        title="Block height"
        hint="How tall a block grows before it scrolls in place. All lets the timeline scroll instead, apart from a 100,000-character ceiling that keeps a runaway payload from stalling layout."
        styles={styles}
      >
        {BLOCK_HEIGHT_KINDS.map((kind, index) => (
          <CompactRow
            key={kind}
            label={BLOCK_HEIGHT_LABELS[kind]}
            hint={BLOCK_HEIGHT_HINTS[kind]}
            controlWidth={244}
            styles={styles}
            stacked={stacked}
            first={index === 0}
          >
            <Segmented<number>
              accessibilityLabel={`${BLOCK_HEIGHT_LABELS[kind]} block height`}
              value={prefs.blockHeights[kind]}
              options={withCurrent(BLOCK_HEIGHT_OPTIONS, prefs.blockHeights[kind])}
              onChange={(value) =>
                change({ blockHeights: { ...prefs.blockHeights, [kind]: value } })
              }
              compact
              styles={styles}
            />
          </CompactRow>
        ))}
      </Group>
    </View>
  );
}

/** A miniature code card showing the chosen chrome. */
function ChromeSample({
  chrome,
  styles,
}: {
  chrome: CodeChrome;
  styles: ReturnType<typeof useDashboardStyles>;
}) {
  const surface = sunken(styles.colors.surface0);
  const rule = alpha(styles.colors.border, 0.6);
  return (
    <View
      style={{
        borderColor: rule,
        borderRadius: 5,
        borderWidth: 1,
        backgroundColor: surface,
        minWidth: 96,
        overflow: "hidden",
      }}
    >
      {chrome !== "bare" ? (
        <View
          style={{
            borderBottomColor: rule,
            borderBottomWidth: StyleSheet.hairlineWidth,
            flexDirection: "row",
            justifyContent: "space-between",
            paddingHorizontal: 6,
            paddingVertical: 3,
          }}
        >
          <View
            style={{
              backgroundColor: styles.colors.foregroundMuted,
              borderRadius: 2,
              height: 5,
              opacity: 0.7,
              width: 26,
            }}
          />
          <View
            style={{
              backgroundColor: styles.colors.foregroundMuted,
              borderRadius: 2,
              height: 5,
              opacity: 0.5,
              width: 10,
            }}
          />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 5, paddingHorizontal: 6, paddingVertical: 5 }}>
        {chrome === "gutter" ? (
          <View style={{ gap: 3 }}>
            {[0, 1, 2].map((line) => (
              <View
                key={line}
                style={{
                  backgroundColor: styles.colors.foregroundMuted,
                  borderRadius: 1,
                  height: 4,
                  opacity: 0.5,
                  width: 6,
                }}
              />
            ))}
          </View>
        ) : null}
        <View style={{ gap: 3 }}>
          {[64, 48, 56].map((width, line) => (
            <View
              key={width}
              style={{
                backgroundColor:
                  line === 1 ? styles.colors.statusSuccess : styles.colors.foreground,
                borderRadius: 1,
                height: 4,
                opacity: line === 1 ? 0.8 : 0.75,
                width,
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function CodePage({ prefs, change, theme, layout }: PageProps) {
  const styles = useDashboardStyles(theme);
  return (
    <View style={{ gap: 24 }}>
      <Group
        title="Shell commands"
        hint="Commands are highlighted with the bash grammar in the plugin's own colors."
        styles={styles}
      >
        <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
          {COMMANDS.map((option) => (
            <Tile
              key={option.value}
              name={option.name}
              selected={prefs.commandColor === option.value}
              onPress={() => change({ commandColor: option.value })}
              styles={styles}
            >
              <Text
                style={{
                  color: styles.colors.foreground,
                  fontFamily: styles.mono,
                  fontSize: 12,
                  opacity: option.value === "off" ? 0.75 : 1,
                }}
              >
                <Text style={{ color: option.value === "off" ? styles.colors.foregroundMuted : styles.colors.statusWarning }}>
                  npm
                </Text>{" "}
                run lint --fix
              </Text>
            </Tile>
          ))}
        </View>
        <Text style={styles.hint}>
          {COMMANDS.find((option) => option.value === prefs.commandColor)?.hint}
        </Text>
      </Group>
      <Group title="Code blocks" hint="Used for commands, file contents, diffs, and reasoning fences." styles={styles}>
        <View accessibilityRole="radiogroup" style={styles.tiles}>
          {CHROME.map((option) => (
            <Tile
              key={option.value}
              name={option.name}
              selected={prefs.codeChrome === option.value}
              onPress={() => change({ codeChrome: option.value })}
              styles={styles}
            >
              <ChromeSample chrome={option.value} styles={styles} />
            </Tile>
          ))}
        </View>
        <Text style={styles.hint}>{CHROME.find((option) => option.value === prefs.codeChrome)?.hint}</Text>
      </Group>
      <Group title="Long lines" hint="Diff lines wrap or scroll sideways; code cards always scroll." styles={styles}>
        <ControlRow label="Diff lines" styles={styles} stacked={layout.compact} first>
          <Segmented
            accessibilityLabel="Diff line wrapping"
            value={prefs.diffWrap}
            options={[
              { value: "on" as const, label: "Wrap" },
              { value: "off" as const, label: "Scroll" },
            ]}
            onChange={(value) => change({ diffWrap: value })}
            styles={styles}
          />
        </ControlRow>
      </Group>
    </View>
  );
}

function RepliesPage({ prefs, change, theme, layout }: PageProps) {
  const styles = useDashboardStyles(theme);
  const web = layout.platform === "web";
  return (
    <View style={{ gap: 24 }}>
      <Group
        title="Reply code"
        hint="Inline code chips and fenced blocks inside Paseo's own assistant replies."
        styles={styles}
      >
        <ControlRow label="Restyle reply code" styles={styles} stacked={layout.compact} first>
          <Segmented<ReplyCode>
            accessibilityLabel="Restyle reply code"
            value={prefs.replyCode}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            onChange={(value) => change({ replyCode: value })}
            styles={styles}
            />
        </ControlRow>
        {web ? (
          <Note styles={styles}>
            Applies to replies in this app. The plugin's own rows (thinking, tool calls, tasks) are
            styled on every platform, including mobile.
          </Note>
        ) : (
          <Note styles={styles}>
            Replies keep Paseo's rendering on iOS and Android: Paseo does not expose a markdown hook
            to plugins, so this restyle is desktop and web only. The plugin's own rows (thinking,
            tool calls, tasks) are styled everywhere.
          </Note>
        )}
      </Group>
      <Group
        title="What it changes"
        hint="The same visual language as the plugin's code cards."
        styles={styles}
      >
        <View style={{ gap: 6 }}>
          <Text style={styles.body}>
            Middleware lives in{" "}
            <Text
              style={{
                backgroundColor: styles.colors.surface2,
                borderRadius: 3,
                color: styles.colors.foreground,
                fontFamily: styles.mono,
                fontSize: 12,
              }}
            >
              {" "}
              requireAuth{" "}
            </Text>{" "}
            and runs once per request.
          </Text>
          <Text style={styles.small}>Inline code: a filled chip in the theme's surface color.</Text>
          <Text style={styles.small}>
            Fenced blocks: a sunken surface, a hairline rule, and a language header with a copy
            control.
          </Text>
        </View>
      </Group>
    </View>
  );
}

export const PAGES = [
  { id: "activity", icon: "Gauge", label: "Activity", group: "DISPLAY" },
  { id: "rows", icon: "ListTree", label: "Rows", group: "DISPLAY" },
  { id: "code", icon: "Code", label: "Code & commands", group: "CONTENT" },
  { id: "replies", icon: "MessageSquareText", label: "Replies", group: "CONTENT" },
] as const;

export type PageId = (typeof PAGES)[number]["id"];

export function Page({ page, ...props }: { page: PageId } & PageProps): ReactNode {
  switch (page) {
    case "activity":
      return <ActivityPage {...props} />;
    case "rows":
      return <RowsPage {...props} />;
    case "code":
      return <CodePage {...props} />;
    case "replies":
      return <RepliesPage {...props} />;
    default:
      return null;
  }
}

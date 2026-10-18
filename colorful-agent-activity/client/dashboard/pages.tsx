import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { alpha, sunken } from "../../shared/color";
import {
  type ActivitySettings,
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
import { ActionButton, ControlRow, Group, Note, Segmented, Tile, useDashboardStyles } from "./controls";

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
 * Line budgets for long blocks, as pickable steps. `0` is "All": the block renders
 * whole and the Show all control disappears.
 */
const CODE_LINE_OPTIONS: { value: number; label: string }[] = [
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 40, label: "40" },
  { value: 80, label: "80" },
  { value: 0, label: "All" },
];

const THINKING_LINE_OPTIONS: { value: number; label: string }[] = [
  { value: 50, label: "50" },
  { value: 150, label: "150" },
  { value: 400, label: "400" },
  { value: 800, label: "800" },
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

function RowsPage({ prefs, change, theme, layout }: PageProps) {
  const styles = useDashboardStyles(theme);
  const stacked = layout.compact;
  const targets = EXPANSION_TARGETS.map((target) => ({
    key: target.key,
    label: target.label,
    mode: prefs.expansion[target.key] ?? DEFAULT_EXPANSION[target.key],
  }));
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
      <Group
        title="Row expansion"
        hint="Always starts expanded, Latest opens only while the row is newest, Never stays collapsed until tapped."
        styles={styles}
      >
        <View style={{ gap: 11 }}>
          {targets.map((target, index) => (
            <ControlRow
              key={target.key}
              label={target.label}
              styles={styles}
              stacked={stacked}
              first={index === 0}
            >
              <Segmented
                accessibilityLabel={`${target.label} expansion`}
                value={target.mode}
                options={[
                  { value: "always" as const, label: "Always" },
                  { value: "latest" as const, label: "Latest" },
                  { value: "never" as const, label: "Never" },
                ]}
                onChange={(value) =>
                  change({
                    expansion: { ...prefs.expansion, [target.key as ExpansionTarget]: value },
                  })
                }
                styles={styles}
              />
            </ControlRow>
          ))}
        </View>
      </Group>
      <Group
        title="Long blocks"
        hint="Lines rendered before a block offers its Show all control. All drops the cut, apart from a 100,000-character ceiling that keeps a runaway payload from stalling layout."
        styles={styles}
      >
        <ControlRow
          label="Thinking"
          hint="Read at its end, so the newest lines are the ones kept."
          styles={styles}
          stacked={stacked}
          first
        >
          <Segmented<number>
            accessibilityLabel="Thinking block lines"
            value={prefs.thinkingLines}
            options={withCurrent(THINKING_LINE_OPTIONS, prefs.thinkingLines)}
            onChange={(value) => change({ thinkingLines: value })}
            styles={styles}
          />
        </ControlRow>
        <ControlRow
          label="File contents & diffs"
          hint="Read from their start, so the opening lines are the ones kept."
          styles={styles}
          stacked={stacked}
        >
          <Segmented<number>
            accessibilityLabel="File and diff block lines"
            value={prefs.previewLines}
            options={withCurrent(CODE_LINE_OPTIONS, prefs.previewLines)}
            onChange={(value) => change({ previewLines: value })}
            styles={styles}
          />
        </ControlRow>
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

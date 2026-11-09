import type { PluginTheme } from "@getpaseo/plugin";
import type { ThemeSyntaxColors } from "./highlight";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type TextInput as NativeTextInput, type ViewStyle } from "react-native";
import { addDefaults, t } from "../shared/i18n";
import { kitTime, kitUi } from "../shared/locales/kit/zh-CN.json";

/**
 * Paseo-native UI kit. Every plugin in this collection carries an identical copy (plugins install
 * independently). The copies are generated from the collection's `kit/` directory: edit that source and sync,
 * never one plugin's copy.
 * Scales mirror the host app: 4-pt spacing, 12/13/14/16 type, 8 px control radius, 28/32 px controls,
 * regular-weight button text, one primary action per view. Surfaces, text and the primary button come from the
 * host theme; states and categories use the vivid palette below (`hue`, `toneColor`, `hueFor`).
 * Words come from `../shared/i18n` (`kitUi`, `kitTime`): the plugin's language once it binds one, else Chinese.
 */
addDefaults({ kitUi, kitTime });

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const fontSize = { meta: 12, small: 13, body: 14, content: 15, title: 16, heading: 18 } as const;
export const radius = { sm: 6, md: 8, lg: 12, full: 999 } as const;
export const control = { sm: 28, md: 32 } as const;
export const hairline = Platform.OS === "web" ? 1 : StyleSheet.hairlineWidth;
/** Extends 28–32 px controls to a comfortable touch target without changing their look. */
const touchSlop = { top: 8, bottom: 8, left: 6, right: 6 };
/**
 * react-native-web ignores `accessibilityState`, so selected / pressed / expanded / busy never reach the DOM.
 * Pass the matching `aria-*` attribute next to it (React Native's types lack some of them, hence the cast).
 */
export const aria = (attributes: Record<string, boolean | string | undefined>): object =>
  Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => [`aria-${key}`, value]));

/** Semantic tones, or any palette hue for categories (e.g. `tone="violet"` for prompts). */
export type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "danger" | Hue;
function luminance(color: string): number | null {
  const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(color);
  const hex = short ? short.slice(1).map(part => part + part).join("") : /^#([a-f\d]{6})(?:[a-f\d]{2})?$/i.exec(color)?.[1];
  if (!hex) return null;
  const [r, g, b] = [0, 2, 4].map(offset => { const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** WCAG contrast ratio; unknown color formats count as readable. */
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return x === null || y === null ? 21 : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const isDarkTheme = (theme: PluginTheme) => contrast(theme.colors.surface0, "#ffffff") > contrast(theme.colors.surface0, "#000000");
/** `#rrggbb` + alpha → `#rrggbbaa`; other formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0")}` : color;
}

/**
 * Vivid palette. Paseo's status colors are deliberately muted; plugin content uses these so states and
 * categories read at a glance on phones and desktops. Per theme lightness:
 * `solid` marks, fills, bars and icons · `text` colored text (≥ 4.5:1 on the theme surfaces) ·
 * `soft` tinted grounds (badges, selected chips, banners) · `line` tinted borders.
 */
export type Hue = "blue" | "sky" | "cyan" | "teal" | "green" | "lime" | "amber" | "orange" | "red" | "pink" | "fuchsia" | "violet" | "indigo" | "gray";
// Bright on dark (400 shades, neon-like), saturated on light (500/600 marks, 600/700 text); text keeps ≥ 4.5:1 on surface0/2.
const palette: Record<Hue, readonly [lightSolid: string, lightText: string, darkSolid: string, darkText: string]> = {
  blue: ["#3B82F6", "#2563EB", "#60A5FA", "#60A5FA"], sky: ["#0284C7", "#0369A1", "#38BDF8", "#38BDF8"],
  cyan: ["#0891B2", "#0E7490", "#22D3EE", "#22D3EE"], teal: ["#0D9488", "#0F766E", "#2DD4BF", "#2DD4BF"],
  green: ["#059669", "#047857", "#34D399", "#34D399"], lime: ["#65A30D", "#4D7C0F", "#A3E635", "#A3E635"],
  amber: ["#D97706", "#B45309", "#FBBF24", "#FBBF24"], orange: ["#EA580C", "#C2410C", "#FB923C", "#FB923C"],
  red: ["#F43F5E", "#BE123C", "#FB7185", "#FB7185"], pink: ["#EC4899", "#BE185D", "#F472B6", "#F472B6"],
  fuchsia: ["#D946EF", "#A21CAF", "#E879F9", "#E879F9"], violet: ["#8B5CF6", "#7C3AED", "#A78BFA", "#A78BFA"],
  indigo: ["#6366F1", "#4F46E5", "#818CF8", "#818CF8"], gray: ["#71717A", "#52525B", "#A1A1AA", "#D4D4D8"],
};
export function hue(theme: PluginTheme, name: Hue, use: "solid" | "text" | "soft" | "line" = "solid"): string {
  const [lightSolid, lightText, darkSolid, darkText] = palette[name], dark = isDarkTheme(theme), solid = dark ? darkSolid : lightSolid;
  return use === "text" ? dark ? darkText : lightText : use === "soft" ? withAlpha(solid, dark ? 0.22 : 0.13) : use === "line" ? withAlpha(solid, dark ? 0.55 : 0.4) : solid;
}
/**
 * Linear gradient background. Native (new architecture) uses `experimental_backgroundImage`, web a CSS `backgroundImage`.
 * `stops` are palette hues or colours; `alpha` fades hue stops. An opaque gradient keeps its first stop as the
 * `backgroundColor` fallback; a translucent wash falls back to transparent (a solid first stop would tint the whole
 * view wherever the image does not draw). `fallback` overrides either choice.
 */
export function gradient(theme: PluginTheme, stops: readonly (Hue | string)[], options: { angle?: number; alpha?: number; fallback?: string } = {}): ViewStyle {
  const colors = stops.map(stop => { const color = stop in palette ? hue(theme, stop as Hue) : stop; return options.alpha === undefined ? color : withAlpha(color, options.alpha); });
  const css = `linear-gradient(${options.angle ?? 135}deg, ${colors.join(", ")})`;
  const translucent = colors.some(color => /^#[0-9a-f]{8}$/i.test(color) && !/ff$/i.test(color) || color === "transparent");
  const fallback = options.fallback ?? (translucent ? "transparent" : colors[0]);
  return { backgroundColor: fallback, ...(Platform.OS === "web" ? { backgroundImage: css } : { experimental_backgroundImage: css }) } as ViewStyle;
}
/** Soft coloured glow around a mark or card (dark themes glow more). */
export function glow(theme: PluginTheme, color: string, radius = 14): ViewStyle {
  return { boxShadow: `0px 0px ${radius}px ${withAlpha(color, isDarkTheme(theme) ? 0.45 : 0.3)}` } as ViewStyle;
}
// Red and amber stay reserved for failures and warnings, so a project never looks like an alarm.
const nameHues: readonly Hue[] = ["blue", "violet", "pink", "teal", "indigo", "orange", "cyan", "green"];
/** A stable hue per name (project, repository, workspace), so the same project has the same color in every plugin. */
export function hueFor(key: string): Hue {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) { hash ^= key.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  // Final avalanche so similar names spread over the hues.
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16;
  return nameHues[(hash >>> 0) % nameHues.length]!;
}
export const toneHues: Record<"info" | "success" | "warning" | "danger", Hue> = { info: "blue", success: "green", warning: "amber", danger: "red" };
/**
 * Tone → color: info blue, success green, warning amber, danger red from the vivid palette; neutral is muted text.
 * Themes may ship a dark accent (Paseo dark uses #20744A on #181B1A), so accent-toned text and marks fall back
 * to the foreground color whenever they would not be readable.
 */
export function toneColor(theme: PluginTheme, tone: Tone, use: "text" | "mark" | "soft" | "line" = "text"): string {
  const { colors } = theme;
  if (tone === "accent") {
    if (use === "soft" || use === "line") return withAlpha(colors.accent, use === "soft" ? 0.16 : 0.45);
    return contrast(colors.accent, use === "text" ? colors.surface2 : colors.surface0) >= (use === "text" ? 4.5 : 3.2) ? colors.accent : colors.foreground;
  }
  if (tone === "neutral") return use === "soft" ? colors.surface2 : use === "line" ? colors.border : colors.foregroundMuted;
  return hue(theme, tone in toneHues ? toneHues[tone as keyof typeof toneHues] : tone as Hue, use === "mark" ? "solid" : use);
}

type Interaction = { pressed: boolean; hovered?: boolean };
const hoverable = (state: unknown) => state as Interaction;

/** Compact layout below 760 px of available width or whenever the host says so. */
export function useCompactLayout(hostCompact: boolean, breakpoint = 760): { compact: boolean; width: number; onLayout: (event: LayoutChangeEvent) => void } {
  const [width, setWidth] = useState(0);
  return { compact: hostCompact || (width > 0 && width < breakpoint), width, onLayout: event => setWidth(event.nativeEvent.layout.width) };
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
/** `grow` fills the free space of a row from the label's own width; a basis of 0 would collapse it inside a column on native. */
export function Button({ theme, label, icon, onPress, variant = "secondary", size = "md", disabled = false, busy = false, grow = false, tone, accessibilityLabel, testID }: {
  theme: PluginTheme; label: string; icon?: string; onPress: () => void; variant?: ButtonVariant; size?: "sm" | "md";
  disabled?: boolean; busy?: boolean; grow?: boolean; accessibilityLabel?: string; testID?: string;
  /** Colors a secondary/ghost button (tinted ground, colored label) — e.g. 跳过评审 amber, 合并 green. */ tone?: Tone;
}) {
  const { colors } = theme;
  const tint = variant === "danger" ? "danger" as const : tone && tone !== "neutral" && variant !== "primary" ? tone : null;
  const background = variant === "primary" ? colors.accent : tint ? toneColor(theme, tint, "soft") : variant === "secondary" ? colors.surface2 : "transparent";
  const foreground = variant === "primary" ? colors.accentForeground : tint ? toneColor(theme, tint, "text") : variant === "ghost" ? colors.foregroundMuted : colors.foreground;
  const inactive = disabled || busy;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled: inactive, busy }} {...aria({ busy: busy || undefined })} disabled={inactive} onPress={onPress} hitSlop={touchSlop}
    style={state => {
      const { pressed, hovered } = hoverable(state);
      return [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs + 2, minHeight: size === "sm" ? control.sm : control.md, paddingHorizontal: size === "sm" ? 10 : space.md, borderRadius: radius.md, backgroundColor: background, borderWidth: tint ? hairline : 0, borderColor: tint ? toneColor(theme, tint, "line") : colors.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        hovered && !inactive && variant !== "primary" && !tint ? { backgroundColor: variant === "secondary" ? colors.surface2 : colors.surface1 } : null, grow ? { flexGrow: 1, flexShrink: 1, minWidth: 0 } : null];
    }}>
    {busy ? <ActivityIndicator size="small" color={foreground} /> : icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} color={foreground} /> : null}
    <Text numberOfLines={1} style={{ color: foreground, fontSize: size === "sm" ? fontSize.small : fontSize.body, fontWeight: variant === "primary" ? "500" : "400" }}>{label}</Text>
  </Pressable>;
}

/** Square icon-only button; `label` is required for screen readers and tooltips. Passing `active` makes it a toggle. */
export function IconButton({ theme, icon, label, onPress, active, disabled = false, tone, size = "md", badge, testID }: {
  theme: PluginTheme; icon: string; label: string; onPress: () => void; active?: boolean; disabled?: boolean; tone?: Tone; size?: "sm" | "md"; badge?: boolean; testID?: string;
}) {
  const { colors } = theme, edge = size === "sm" ? control.sm : control.md, on = active ?? false;
  const color = tone ? toneColor(theme, tone) : on ? colors.foreground : colors.foregroundMuted;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected: on }} {...aria({ pressed: active })} disabled={disabled} onPress={onPress} hitSlop={touchSlop}
    style={state => {
      const { pressed, hovered } = hoverable(state);
      return { width: edge, height: edge, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: on ? colors.surface2 : hovered || pressed ? colors.surface1 : "transparent", opacity: disabled ? 0.4 : pressed ? 0.8 : 1 };
    }}>
    <Icon name={icon} size={size === "sm" ? 14 : 16} color={color} />
    {badge ? <View style={{ position: "absolute", top: 5, right: 5, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent, borderWidth: 1.5, borderColor: colors.surface0 }} /> : null}
  </Pressable>;
}

/** The single top bar of a surface or pane. Never repeat the host title here; put context and actions in it. */
export function Toolbar({ theme, children, border = true, style }: { theme: PluginTheme; children: ReactNode; border?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: border ? hairline : 0, borderBottomColor: theme.colors.border }, style]}>{children}</View>;
}
export const Spacer = () => <View style={{ flex: 1 }} />;

/** Horizontally scrolling row of chips (filters, scopes); never wraps into several lines on phones. */
export function ChipBar({ children, border = false, theme }: { children: ReactNode; border?: boolean; theme?: PluginTheme }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, flexShrink: 0, ...(border && theme ? { borderBottomWidth: hairline, borderBottomColor: theme.colors.border } : {}) }}
    contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm }}>{children}</ScrollView>;
}

export type Option<Value extends string> = { value: Value; label: string; count?: number; icon?: string; tone?: Tone };
/** 2–4 mutually exclusive views of the same content. */
export function Segmented<Value extends string>({ theme, value, options, onChange, size = "md", accessibilityLabel }: {
  theme: PluginTheme; value: Value; options: readonly Option<Value>[]; onChange: (value: Value) => void; size?: "sm" | "md"; accessibilityLabel?: string;
}) {
  const { colors } = theme;
  return <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={{ flexDirection: "row", alignSelf: "flex-start", padding: space.xxs, gap: space.xxs, borderRadius: radius.md, backgroundColor: colors.surface2 }}>
    {options.map(option => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityLabel={option.count === undefined ? option.label : `${option.label} ${option.count}`} accessibilityState={{ selected }} aria-selected={selected} onPress={() => onChange(option.value)} hitSlop={{ top: 6, bottom: 6 }}
        style={state => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 1, minHeight: size === "sm" ? 24 : control.md - 2 * space.xxs, paddingHorizontal: size === "sm" ? space.sm : 10, borderRadius: radius.sm, backgroundColor: selected ? colors.surface0 : hoverable(state).hovered ? colors.surface1 : "transparent", borderWidth: selected ? hairline : 0, borderColor: colors.border })}>
        {option.icon ? <Icon name={option.icon} size={14} color={option.tone ? toneColor(theme, option.tone, "mark") : selected ? colors.foreground : colors.foregroundMuted} /> : null}
        <Text numberOfLines={1} style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? "500" : "400" }}>{option.label}</Text>
        {option.count !== undefined ? <Text style={{ color: option.tone && option.count ? toneColor(theme, option.tone) : colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: option.tone && option.count ? "600" : "400", fontVariant: ["tabular-nums"] }}>{option.count}</Text> : null}
      </Pressable>;
    })}
  </View>;
}

/** Section tabs inside a detail pane (讨论 / 文件 / 检查 …). */
export function Tabs<Value extends string>({ theme, value, options, onChange }: { theme: PluginTheme; value: Value; options: readonly Option<Value>[]; onChange: (value: Value) => void }) {
  const { colors } = theme;
  return <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: space.lg, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
    {options.map(option => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityLabel={option.count === undefined ? option.label : `${option.label} ${option.count}`} accessibilityState={{ selected }} aria-selected={selected} onPress={() => onChange(option.value)}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 1, minHeight: 40, marginBottom: -hairline, borderBottomWidth: 2, borderBottomColor: selected ? option.tone ? toneColor(theme, option.tone, "mark") : colors.foreground : "transparent" }}>
        {option.icon ? <Icon name={option.icon} size={14} color={option.tone ? toneColor(theme, option.tone, "mark") : selected ? colors.foreground : colors.foregroundMuted} /> : null}
        <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.body, fontWeight: selected ? "500" : "400" }}>{option.label}</Text>
        {option.count !== undefined ? <Text style={{ color: option.tone && option.count ? toneColor(theme, option.tone) : colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: option.tone && option.count ? "600" : "400", fontVariant: ["tabular-nums"] }}>{option.count}</Text> : null}
      </Pressable>;
    })}
  </View>;
}

/** Filter / quick-scope pill. With `onRemove` it becomes an applied-filter token. */
export function Chip({ theme, label, icon, count, tone, selected = false, onPress, onRemove, testID }: {
  theme: PluginTheme; label: string; icon?: string; count?: number; tone?: Tone; selected?: boolean; onPress?: () => void; onRemove?: () => void; testID?: string;
}) {
  const { colors } = theme, color = tone ? toneColor(theme, tone, "mark") : selected ? colors.foreground : colors.foregroundMuted;
  const body = <>
    {tone && !icon ? <StatusDot theme={theme} tone={tone} size={7} /> : icon ? <Icon name={icon} size={13} color={color} /> : null}
    <Text numberOfLines={1} style={{ color: selected || tone ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? "500" : "400" }}>{label}</Text>
    {count !== undefined ? <Text style={{ color: tone && tone !== "neutral" && count ? toneColor(theme, tone) : colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: tone && count ? "600" : "400", fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
  </>;
  const remove = onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={t("kitUi.remove", { label })} onPress={onRemove} hitSlop={8}><Icon name="X" size={12} color={colors.foregroundMuted} /></Pressable> : null;
  const tinted = tone && tone !== "neutral";
  const style = (hovered = false): ViewStyle => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 1, minHeight: control.sm, paddingHorizontal: 10, borderRadius: radius.full, borderWidth: hairline,
    borderColor: selected ? tinted ? toneColor(theme, tone, "mark") : colors.foregroundMuted : tinted ? toneColor(theme, tone, "line") : colors.border,
    backgroundColor: selected ? tinted ? toneColor(theme, tone, "soft") : colors.surface2 : hovered ? colors.surface1 : "transparent" });
  const pressLabel = count === undefined ? label : `${label} ${count}`;
  if (!onPress) return <View testID={testID} style={style()}>{body}{remove}</View>;
  if (!remove) return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={pressLabel} accessibilityState={{ selected }} {...aria({ pressed: selected })} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }} style={state => [style(hoverable(state).hovered), { opacity: hoverable(state).pressed ? 0.8 : 1 }]}>{body}</Pressable>;
  // Both actions: two sibling buttons inside one pill, so the web never renders a <button> inside a <button>.
  return <View testID={testID} style={[style(), { paddingHorizontal: 0, gap: 0 }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={pressLabel} accessibilityState={{ selected }} {...aria({ pressed: selected })} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }}
      style={state => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 1, minHeight: control.sm, paddingLeft: 10, paddingRight: space.xs, opacity: hoverable(state).pressed ? 0.8 : 1 })}>{body}</Pressable>
    <View style={{ paddingRight: 10 }}>{remove}</View>
  </View>;
}

/** Small label: state, count or category, on a ground tinted with its tone (`solid` for the loudest ones). */
export function Badge({ theme, label, tone = "neutral", icon, solid = false }: { theme: PluginTheme; label: string; tone?: Tone; icon?: string; solid?: boolean }) {
  const loud = solid && tone !== "neutral", color = loud ? "#ffffff" : toneColor(theme, tone);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start", minHeight: 20, paddingHorizontal: space.xs + 2, borderRadius: radius.sm - 2, backgroundColor: loud ? toneColor(theme, tone, "mark") : toneColor(theme, tone, "soft") }}>
    {icon ? <Icon name={icon} size={12} color={loud ? color : toneColor(theme, tone, "mark")} /> : null}
    <Text numberOfLines={1} style={{ color: tone === "neutral" ? theme.colors.foregroundMuted : color, fontSize: fontSize.meta, fontWeight: "500" }}>{label}</Text>
  </View>;
}

export function StatusDot({ theme, tone, size = 8 }: { theme: PluginTheme; tone: Tone; size?: number }) {
  return <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tone === "neutral" ? theme.colors.foregroundMuted : toneColor(theme, tone, "mark"), opacity: tone === "neutral" ? 0.6 : 1 }} />;
}

/** A dot in any palette hue (legends, categories, project colors). */
export function HueDot({ theme, hue: name, size = 8 }: { theme: PluginTheme; hue: Hue; size?: number }) {
  return <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: hue(theme, name) }} />;
}
/** Colored initial for a project / repository / workspace; the color is stable per name (`hueFor`). */
export function ProjectMark({ theme, name, size = 18 }: { theme: PluginTheme; name: string; size?: number }) {
  const initial = Array.from(name.trim().replace(/^[^\p{L}\p{N}]+/u, ""))[0]?.toUpperCase() ?? "#";
  return <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), alignItems: "center", justifyContent: "center", backgroundColor: hue(theme, hueFor(name)) }}>
    <Text style={{ color: "#ffffff", fontSize: Math.round(size * 0.6), lineHeight: size, fontWeight: "600", textAlign: "center" }}>{initial}</Text>
  </View>;
}

/** "a · b · c" secondary line; falsy parts are skipped. */
export function MetaLine({ theme, parts, numberOfLines = 1, selectable = false }: { theme: PluginTheme; parts: readonly (string | number | null | undefined | false)[]; numberOfLines?: number; selectable?: boolean }) {
  const text = parts.filter(part => part !== null && part !== undefined && part !== false && part !== "").join(t("kitUi.metaSeparator"));
  return text ? <Text selectable={selectable} numberOfLines={numberOfLines} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{text}</Text> : null;
}

/** The list primitive: whole row pressable, title first, one muted meta line, optional trailing time/badge. */
export function Row({ theme, title, subtitle, leading, trailing, onPress, selected = false, titleLines = 2, children, accessibilityLabel, testID }: {
  theme: PluginTheme; title: string; subtitle?: ReactNode; leading?: ReactNode; trailing?: ReactNode; onPress?: () => void; selected?: boolean; titleLines?: number;
  children?: ReactNode; accessibilityLabel?: string; testID?: string;
}) {
  const { colors } = theme;
  const content = <>
    {leading ? <View style={{ minHeight: 20, justifyContent: "center" }}>{leading}</View> : null}
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        <Text numberOfLines={titleLines} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, lineHeight: 20, fontWeight: "500" }}>{title}</Text>
        {trailing ? <View style={{ minHeight: 20, justifyContent: "center", alignItems: "flex-end" }}>{trailing}</View> : null}
      </View>
      {typeof subtitle === "string" ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{subtitle}</Text> : subtitle}
      {children}
    </View>
  </>;
  const frame: ViewStyle = { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, paddingHorizontal: space.md, borderRadius: radius.md };
  if (!onPress) return <View testID={testID} style={frame}>{content}</View>;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ selected }} {...aria({ current: selected ? "true" : undefined })} onPress={onPress}
    style={state => { const { pressed, hovered } = hoverable(state); return [frame, { backgroundColor: selected ? colors.surface2 : pressed || hovered ? colors.surface1 : "transparent" }]; }}>{content}</Pressable>;
}

/** Group header inside a list. Collapsible when `open`/`onToggle` are given. */
export function SectionHeader({ theme, title, count, action, open, onToggle, icon, tone }: { theme: PluginTheme; title: string; count?: number; action?: ReactNode; open?: boolean; onToggle?: () => void; icon?: string; tone?: Tone }) {
  const { colors } = theme;
  const tinted = tone && tone !== "neutral" ? toneColor(theme, tone) : null;
  const label = <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flex: 1 }}>
    {onToggle ? <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} /> : null}
    {icon ? <Icon name={icon} size={13} color={tone ? toneColor(theme, tone, "mark") : colors.foregroundMuted} /> : null}
    <Text style={{ color: tinted ?? colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: tinted ? "600" : "500" }}>{title}</Text>
    {count !== undefined ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"], opacity: 0.8 }}>{count}</Text> : null}
  </View>;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32, paddingHorizontal: space.md, paddingTop: space.sm }}>
    {onToggle ? <Pressable accessibilityRole="button" accessibilityLabel={t(open ? "kitUi.collapse" : "kitUi.expand", { title })} accessibilityState={{ expanded: open }} {...aria({ expanded: open })} onPress={onToggle} style={{ flex: 1 }}>{label}</Pressable> : label}
    {action}
  </View>;
}

export function Divider({ theme, inset = 0 }: { theme: PluginTheme; inset?: number }) {
  return <View style={{ height: hairline, marginLeft: inset, backgroundColor: theme.colors.border }} />;
}

/** One-line inline message. Use for errors and states that need a decision; prefer toasts for confirmations. */
export function Banner({ theme, tone = "neutral", message, icon, action, onDismiss }: {
  theme: PluginTheme; tone?: Tone; message: string; icon?: string; action?: { label: string; onPress: () => void }; onDismiss?: () => void;
}) {
  const { colors } = theme, color = toneColor(theme, tone);
  // Message text stays foreground: red text on a red-tinted ground falls under 4.5:1 on dark themes.
  const glyph = icon ?? (tone === "danger" ? "CircleAlert" : tone === "warning" ? "TriangleAlert" : tone === "success" ? "CircleCheck" : "Info");
  const tinted = tone !== "neutral";
  return <View accessibilityRole={tone === "danger" ? "alert" : undefined} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, paddingLeft: space.md, paddingRight: action || onDismiss ? space.xs : space.md, borderRadius: radius.md, backgroundColor: tinted ? toneColor(theme, tone, "soft") : colors.surface1, borderWidth: hairline, borderColor: tinted ? toneColor(theme, tone, "line") : colors.border }}>
    <Icon name={glyph} size={16} color={tinted ? toneColor(theme, tone, "mark") : color} />
    <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, lineHeight: 19, fontWeight: tone === "danger" ? "500" : "400" }}>{message}</Text>
    {action ? <Button theme={theme} label={action.label} size="sm" variant="ghost" onPress={action.onPress} /> : null}
    {onDismiss ? <IconButton theme={theme} icon="X" label={t("kitUi.dismiss")} size="sm" onPress={onDismiss} /> : null}
  </View>;
}

export function EmptyState({ theme, icon, title, message, action, tone = "info" }: { theme: PluginTheme; icon: string; title: string; message?: string; action?: { label: string; onPress: () => void; icon?: string }; tone?: Tone }) {
  const { colors } = theme;
  return <View style={{ alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.xl, paddingVertical: 40 }}>
    <View style={{ width: 44, height: 44, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: toneColor(theme, tone, "soft"), marginBottom: space.xs }}><Icon name={icon} size={22} color={tone === "neutral" ? colors.foregroundMuted : toneColor(theme, tone, "mark")} /></View>
    <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "500", textAlign: "center" }}>{title}</Text>
    {message ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19, textAlign: "center", maxWidth: 300 }}>{message}</Text> : null}
    {action ? <View style={{ marginTop: space.xs }}><Button theme={theme} label={action.label} icon={action.icon} size="sm" onPress={action.onPress} /></View> : null}
  </View>;
}

/** First-load placeholder shaped like `Row`s. Background refreshes must not show it. */
export function Skeleton({ theme, rows = 4 }: { theme: PluginTheme; rows?: number }) {
  const bar = (width: `${number}%`, height: number) => <View style={{ width, height, borderRadius: 4, backgroundColor: theme.colors.surface2 }} />;
  return <View accessibilityRole="progressbar" accessibilityLabel={t("kitUi.loading")} style={{ gap: space.xs, paddingVertical: space.xs }}>
    {Array.from({ length: rows }, (_, index) => <View key={index} style={{ flexDirection: "row", gap: 10, paddingVertical: 10, paddingHorizontal: space.md, opacity: 1 - index * 0.15 }}>
      <View style={{ width: 8, height: 8, marginTop: 6, borderRadius: 4, backgroundColor: theme.colors.surface2 }} />
      <View style={{ flex: 1, gap: 7 }}>{bar(`${88 - (index % 3) * 14}%`, 12)}{bar(`${46 + (index % 2) * 12}%`, 9)}</View>
    </View>)}
  </View>;
}

/** Quiet sync state for toolbars: a dot plus optional short label ("同步中", "3 分钟前"). */
export function SyncStatus({ theme, state, label }: { theme: PluginTheme; state: "live" | "syncing" | "stale" | "error"; label?: string }) {
  const tone: Tone = state === "live" ? "success" : state === "error" ? "danger" : state === "stale" ? "warning" : "neutral";
  const spoken = label ?? t(state === "live" ? "kitUi.syncLive" : state === "syncing" ? "kitUi.syncSyncing" : state === "stale" ? "kitUi.syncStale" : "kitUi.syncError");
  return <View accessibilityLabel={spoken} style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
    {state === "syncing" ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : <StatusDot theme={theme} tone={tone} size={6} />}
    {label ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{label}</Text> : null}
  </View>;
}

/**
 * Autofocus once the host sheet has finished opening (about 300 ms): focusing during the opening animation makes
 * web scroll the half-laid-out form, and on phones the keyboard pushes a sheet that is still moving.
 */
export function useSettledFocus(enabled: boolean, delay = 350) {
  const ref = useRef<NativeTextInput>(null);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => ref.current?.focus(), delay);
    return () => clearTimeout(timer);
  }, [enabled, delay]);
  return ref;
}

/** `grow` fills a row. It keeps the content-sized basis: `flex: 1` (basis 0) collapses the field's parent on native, so whatever follows overlaps it. */
export function SearchField({ theme, value, onChangeText, placeholder = t("kitUi.search"), onSubmit, autoFocus = false, accessibilityLabel, grow = true }: {
  theme: PluginTheme; value: string; onChangeText: (value: string) => void; placeholder?: string; onSubmit?: () => void; autoFocus?: boolean; accessibilityLabel?: string; grow?: boolean;
}) {
  const { colors } = theme, input = useSettledFocus(autoFocus);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: control.md, paddingLeft: 10, paddingRight: value ? space.xxs : 10, borderRadius: radius.md, backgroundColor: colors.surface2, ...(grow ? { flexGrow: 1, flexShrink: 1, minWidth: 0 } : {}) }}>
    <Icon name="Search" size={14} color={colors.foregroundMuted} />
    <TextInput ref={input} accessibilityLabel={accessibilityLabel ?? placeholder} value={value} onChangeText={onChangeText} onSubmitEditing={onSubmit} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted}
      autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: fontSize.body, paddingVertical: 6 }} />
    {value ? <IconButton theme={theme} icon="X" label={t("kitUi.clearSearch")} size="sm" onPress={() => onChangeText("")} /> : null}
  </View>;
}

export function TextField({ theme, label, value, onChangeText, placeholder, multiline = false, minHeight, autoFocus = false, editable = true, hint }: {
  theme: PluginTheme; label: string; value: string; onChangeText: (value: string) => void; placeholder?: string; multiline?: boolean; minHeight?: number; autoFocus?: boolean; editable?: boolean; hint?: string;
}) {
  const { colors } = theme, input = useSettledFocus(autoFocus && editable);
  return <View style={{ gap: space.xs + 2 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{label}</Text>
    <TextInput ref={input} accessibilityLabel={label} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted} multiline={multiline} editable={editable}
      textAlignVertical={multiline ? "top" : "center"} style={{ color: colors.foreground, backgroundColor: colors.surface2, borderRadius: radius.md, minHeight: minHeight ?? (multiline ? 120 : 36), paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: fontSize.body, lineHeight: 20, opacity: editable ? 1 : 0.6 }} />
    {hint ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{hint}</Text> : null}
  </View>;
}

/** Host-styled modal: a bottom sheet on phones, a dialog on desktop. */
export function Sheet({ title, open, onClose, children, scrollable = true }: { title: string; open: boolean; onClose: () => void; children: ReactNode; scrollable?: boolean }) {
  return <Modal title={title} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content scrollable={scrollable} contentContainerStyle={{ padding: space.lg, gap: space.md }}>{children}</Modal.Content>
  </Modal>;
}

export type MenuAction = { key: string; label: string; icon?: string; onPress: () => void; tone?: Tone; disabled?: boolean; hint?: string };
/** Overflow ("···") actions. Keep frequent actions out of here — they belong in the toolbar. */
export function ActionMenu({ theme, title, open, onClose, actions }: { theme: PluginTheme; title: string; open: boolean; onClose: () => void; actions: readonly MenuAction[] }) {
  const { colors } = theme;
  return <Modal title={title} open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: 0 }}>
      {actions.map(action => {
        const color = action.tone === "danger" ? toneColor(theme, "danger") : colors.foreground;
        return <Pressable key={action.key} accessibilityRole="button" accessibilityLabel={action.label} accessibilityState={{ disabled: !!action.disabled }} disabled={action.disabled} onPress={() => { onClose(); action.onPress(); }}
          style={state => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: hoverable(state).pressed || hoverable(state).hovered ? colors.surface1 : "transparent", opacity: action.disabled ? 0.45 : 1 })}>
          {action.icon ? <Icon name={action.icon} size={16} color={action.tone && action.tone !== "neutral" ? toneColor(theme, action.tone, "mark") : colors.foregroundMuted} /> : null}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color, fontSize: fontSize.body }}>{action.label}</Text>
            {action.hint ? <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{action.hint}</Text> : null}
          </View>
        </Pressable>;
      })}
    </Modal.Content>
  </Modal>;
}

/** Thumb-reach action bar pinned to the bottom of compact detail views. */
export function BottomBar({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, borderTopWidth: hairline, borderTopColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>{children}</View>;
}

/** List | detail on wide layouts; one pane at a time on compact ones. */
export function SplitView({ theme, compact, showDetail, list, detail, listWidth = 360 }: { theme: PluginTheme; compact: boolean; showDetail: boolean; list: ReactNode; detail: ReactNode; listWidth?: number }) {
  if (compact) return <View style={{ flex: 1, minHeight: 0 }}>{showDetail ? detail : list}</View>;
  return <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
    <View style={{ width: listWidth, minWidth: 280, minHeight: 0, borderRightWidth: hairline, borderRightColor: theme.colors.border }}>{list}</View>
    <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{detail}</View>
  </View>;
}

/** just now / 5 minutes ago / 3 hours ago / yesterday 14:20 / Sep 20 / Sep 20, 2025 (刚刚 / 5 分钟前 / … in Chinese) */
export function relativeTime(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return t("kitTime.justNow");
  if (seconds < 3600) return t("kitTime.minutesAgo", { count: Math.max(1, Math.round(seconds / 60)) });
  const today = new Date(now), sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay(date, today)) return seconds < 6 * 3600 ? t("kitTime.hoursAgo", { count: Math.round(seconds / 3600) }) : t("kitTime.todayAt", { time: clock });
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(date, yesterday)) return t("kitTime.yesterdayAt", { time: clock });
  const month = t("kitTime.months").split("|")[date.getMonth()] ?? String(date.getMonth() + 1);
  return date.getFullYear() === today.getFullYear()
    ? t("kitTime.monthDay", { month, day: date.getDate() })
    : t("kitTime.yearMonthDay", { year: date.getFullYear(), month, day: date.getDate() });
}

/** 42s / 3m 20s / 2h 5m (42 秒 / 3 分 20 秒 / 2 小时 5 分 in Chinese) */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return t("kitTime.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? t("kitTime.minutesSeconds", { minutes, seconds: seconds % 60 }) : t("kitTime.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? t("kitTime.hoursMinutes", { hours, minutes: minutes % 60 }) : t("kitTime.hours", { count: hours });
}

/** 980 / 12.3k / 4.5M */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 0.11.0:「命令着色」的 vivid 派生语法色：10 种 shell token kind → 调色板 hue（命令橙/关键字紫/字符串绿/变量青…）。
 *  仅命令着色路径（CommandTokens/shellSegments）传入；其余代码高亮走既有 3 色通道。 */
export function vividSyntaxColors(theme: PluginTheme): ThemeSyntaxColors {
  return {
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    accent: hue(theme, "violet", "text"),
    statusSuccess: hue(theme, "green", "text"),
    statusWarning: hue(theme, "amber", "text"),
    statusDanger: hue(theme, "red", "text"),
    builtin: hue(theme, "orange", "text"),
    keyword: hue(theme, "violet", "text"),
    variable: hue(theme, "cyan", "text"),
    operator: hue(theme, "sky", "text"),
    parameter: hue(theme, "indigo", "text"),
    // 0.11.0:boolean/constant 拆出紫（青柠）、heredoc 原始块用鸭羽绿——都避开红/蓝状态语义色。
    constant: hue(theme, "lime", "text"),
    heredoc: hue(theme, "teal", "text"),
  };
}

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { alpha, rule, sunken } from "../../shared/color";

/**
 * One style object for the whole dashboard, derived from the host theme.
 *
 * Values are computed once per theme rather than per component, so tiles, rails,
 * and the preview always agree on radii, spacing, and the derived surfaces the
 * activity rows use.
 */
export function useDashboardStyles(theme: PluginTheme) {
  const c = theme.colors;
  return useMemo(() => {
    const hairline = StyleSheet.hairlineWidth;
    const railColor = rule(c.border);
    const soft = alpha(c.border, 0.45);
    const codeSurface = sunken(c.surface0);
    const mono = Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    });
    const ui = Platform.select({
      ios: "System",
      android: "sans-serif",
      default:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    });
    const label: TextStyle = {
      color: c.foregroundMuted,
      fontFamily: ui,
      fontSize: 10,
      fontWeight: "600",
      letterSpacing: 0.8,
      lineHeight: 14,
      textTransform: "uppercase",
    };
    const body: TextStyle = {
      color: c.foreground,
      fontFamily: ui,
      fontSize: 13,
      lineHeight: 19,
    };
    const hint: TextStyle = {
      color: c.foregroundMuted,
      fontFamily: ui,
      fontSize: 12,
      lineHeight: 17,
    };
    return {
      ui,
      mono,
      hairline,
      railColor,
      soft,
      codeSurface,
      colors: c,
      page: {
        flex: 1,
        minWidth: 0,
      } satisfies ViewStyle,
      title: {
        color: c.foreground,
        fontFamily: ui,
        fontSize: 17,
        fontWeight: "600",
        lineHeight: 23,
      } satisfies TextStyle,
      subtitle: {
        color: c.foregroundMuted,
        fontFamily: ui,
        fontSize: 12,
        lineHeight: 17,
      } satisfies TextStyle,
      label,
      body,
      hint,
      small: {
        color: c.foregroundMuted,
        fontFamily: ui,
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      monoText: {
        color: c.foreground,
        fontFamily: mono,
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      sectionTitle: {
        color: c.foreground,
        fontFamily: ui,
        fontSize: 13,
        fontWeight: "600",
        lineHeight: 18,
      } satisfies TextStyle,
      rail: {
        borderRightColor: railColor,
        borderRightWidth: hairline,
        gap: 22,
        paddingHorizontal: 12,
        paddingVertical: 18,
        width: 216,
      } satisfies ViewStyle,
      railItem: {
        alignItems: "center",
        borderRadius: 6,
        flexDirection: "row",
        gap: 9,
        paddingHorizontal: 8,
        paddingVertical: 7,
      } satisfies ViewStyle,
      railItemText: {
        color: c.foregroundMuted,
        flex: 1,
        fontFamily: ui,
        fontSize: 13,
        lineHeight: 18,
      } satisfies TextStyle,
      tiles: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
      } satisfies ViewStyle,
      tile: {
        backgroundColor: c.surface1,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.border,
        // Narrow intrinsic width on purpose: with a wider one, four tiles wrap to
        // three plus a stretched orphan instead of sharing one row.
        flexGrow: 1,
        minWidth: 96,
        overflow: "hidden",
      } satisfies ViewStyle,
      tileActive: {
        borderColor: c.accent,
        borderWidth: 1.5,
      } satisfies ViewStyle,
      tileBody: {
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 9,
      } satisfies ViewStyle,
      tilePreview: {
        alignItems: "center",
        backgroundColor: codeSurface,
        flexDirection: "row",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 10,
      } satisfies ViewStyle,
      tileName: {
        color: c.foregroundMuted,
        fontFamily: ui,
        fontSize: 12,
        lineHeight: 17,
      } satisfies TextStyle,
      segmented: {
        backgroundColor: c.surface0,
        borderColor: c.border,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: "row",
        gap: 2,
        padding: 2,
      } satisfies ViewStyle,
      segment: {
        alignItems: "center",
        borderRadius: 5,
        flex: 1,
        justifyContent: "center",
        minHeight: 28,
        paddingHorizontal: 8,
        paddingVertical: 4,
      } satisfies ViewStyle,
      segmentText: {
        color: c.foregroundMuted,
        fontFamily: ui,
        fontSize: 12,
        lineHeight: 17,
        textAlign: "center",
      } satisfies TextStyle,
      rowLabel: {
        color: c.foreground,
        fontFamily: ui,
        fontSize: 13,
        lineHeight: 18,
      } satisfies TextStyle,
      button: {
        alignItems: "center",
        borderColor: c.border,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: "row",
        gap: 6,
        paddingHorizontal: 11,
        paddingVertical: 7,
      } satisfies ViewStyle,
      buttonText: {
        color: c.foreground,
        fontFamily: ui,
        fontSize: 12,
        fontWeight: "500",
        lineHeight: 17,
      } satisfies TextStyle,
      note: {
        backgroundColor: alpha(c.accent, 0.08),
        borderLeftColor: alpha(c.accent, 0.5),
        borderLeftWidth: 2,
        borderRadius: 4,
        flexDirection: "row",
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      } satisfies ViewStyle,
      card: {
        backgroundColor: c.surface0,
        borderColor: c.border,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: "hidden",
      } satisfies ViewStyle,
      cardHead: {
        alignItems: "center",
        borderBottomColor: railColor,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: "row",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 9,
      } satisfies ViewStyle,
      badge: {
        backgroundColor: alpha(c.statusSuccess, 0.14),
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
      } satisfies ViewStyle,
      badgeText: {
        color: c.statusSuccess,
        fontFamily: ui,
        fontSize: 10,
        fontWeight: "600",
        lineHeight: 14,
      } satisfies TextStyle,
      frame: {
        alignSelf: "center",
        borderColor: soft,
        borderRadius: 12,
        borderWidth: 1,
        padding: 12,
        width: "100%",
      } satisfies ViewStyle,
      bubble: {
        alignSelf: "flex-end",
        backgroundColor: c.surface1,
        borderRadius: 10,
        maxWidth: "86%",
        paddingHorizontal: 10,
        paddingVertical: 7,
      } satisfies ViewStyle,
      bubbleText: {
        color: c.foreground,
        fontFamily: ui,
        fontSize: 12,
        lineHeight: 17,
      } satisfies TextStyle,
    };
  }, [theme]);
}

export type DashboardStyles = ReturnType<typeof useDashboardStyles>;

export function DashboardLabel({ children, style }: { children: ReactNode; style: TextStyle }) {
  return <Text style={style}>{children}</Text>;
}

export function SectionHead({
  title,
  hint,
  styles,
}: {
  title: string;
  hint?: string;
  styles: DashboardStyles;
}) {
  return (
    <View style={{ gap: 3 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Group({
  title,
  hint,
  children,
  styles,
  style,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  styles: DashboardStyles;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap: 9 }, style]}>
      <SectionHead title={title} hint={hint} styles={styles} />
      {children}
    </View>
  );
}

/** A segmented control: one choice out of a few, always visible together. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  styles,
  accessibilityLabel,
}: {
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  styles: DashboardStyles;
  accessibilityLabel: string;
}) {
  return (
    <View accessibilityLabel={accessibilityLabel} accessibilityRole="radiogroup" style={styles.segmented}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled: !!option.disabled }}
            disabled={option.disabled}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              active ? { backgroundColor: styles.colors.surface2 } : null,
              option.disabled ? { opacity: 0.5 } : null,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                active ? { color: styles.colors.foreground, fontWeight: "600" } : null,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A labeled setting row: description on the left, control on the right (or underneath when narrow). */
export function ControlRow({
  label,
  hint,
  children,
  styles,
  stacked,
  first,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  styles: DashboardStyles;
  stacked?: boolean;
  first?: boolean;
}) {
  return (
    <View
      style={{
        gap: stacked ? 8 : 14,
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "stretch" : "center",
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: styles.railColor,
        paddingTop: first ? 0 : 11,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View style={stacked ? undefined : { width: 220 }}>{children}</View>
    </View>
  );
}

/** A choice tile with its own little preview, so the effect is visible before selecting. */
export function Tile({
  name,
  selected,
  onPress,
  children,
  styles,
}: {
  name: string;
  selected: boolean;
  onPress: () => void;
  children: ReactNode;
  styles: DashboardStyles;
}) {
  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.tile, selected ? styles.tileActive : null]}
    >
      <View style={styles.tilePreview}>{children}</View>
      <View style={styles.tileBody}>
        <View style={{ alignItems: "center", flexDirection: "row", gap: 6 }}>
          <Text
            numberOfLines={1}
            style={[
              styles.tileName,
              { flex: 1 },
              selected ? { color: styles.colors.foreground } : null,
            ]}
          >
            {name}
          </Text>
          {selected ? <Icon name="Check" size={12} color={styles.colors.accent} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

export function ActionButton({
  label,
  icon,
  onPress,
  styles,
  disabled,
  tone,
}: {
  label: string;
  icon?: string;
  onPress: () => void;
  styles: DashboardStyles;
  disabled?: boolean;
  tone?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled ? { opacity: 0.5 } : null]}
    >
      {icon ? <Icon name={icon} size={13} color={tone ?? styles.colors.foregroundMuted} /> : null}
      <Text style={[styles.buttonText, tone ? { color: tone } : null]}>{label}</Text>
    </Pressable>
  );
}

export function Note({ children, styles }: { children: ReactNode; styles: DashboardStyles }) {
  return (
    <View style={styles.note}>
      <Icon name="Info" size={13} color={styles.colors.accent} />
      <Text style={[styles.hint, { flex: 1 }]}>{children}</Text>
    </View>
  );
}

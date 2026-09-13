import type { FC } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type {
  ParsedColor,
  ThemeAppearance,
  ThemeStudioTokens,
  ThemeTokenKey,
} from "../shared/theme-types.js";
import { normalizeHex } from "../shared/parser.js";

export interface TokenMapperProps {
  theme: PluginTheme;
  tokens: ThemeStudioTokens;
  appearance: ThemeAppearance;
  availableColors: ParsedColor[];
  onChangeToken: (key: ThemeTokenKey, hex: string) => void;
  onToggleAppearance: (appearance: ThemeAppearance) => void;
  onAutoMap: () => void;
}

interface TokenMetadata {
  key: ThemeTokenKey;
  label: string;
  description: string;
}

const TOKEN_DEFINITIONS: TokenMetadata[] = [
  { key: "background", label: "Background", description: "Base window and sidebar surface" },
  { key: "raised", label: "Raised Surface", description: "Tool call cards, modals, popovers" },
  { key: "control", label: "Control / Input", description: "Buttons, text inputs, user bubble" },
  { key: "border", label: "Border", description: "Dividers, frame borders, card outlines" },
  { key: "ring", label: "Ring", description: "Focus outlines, subtle accents" },
  { key: "foreground", label: "Foreground", description: "Primary text and icons" },
  { key: "mutedForeground", label: "Muted Text", description: "Secondary text, timestamps, labels" },
  { key: "accent", label: "Accent", description: "Action buttons, active indicators, highlights" },
];

export const TokenMapper: FC<TokenMapperProps> = ({
  theme,
  tokens,
  appearance,
  availableColors,
  onChangeToken,
  onToggleAppearance,
  onAutoMap,
}) => {
  return (
    <View style={styles.container}>
      {/* Controls Bar */}
      <View style={[styles.controlsRow, { borderBottomColor: theme.colors.border }]}>
        <View style={styles.appearanceGroup}>
          <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]}>Theme Tokens</Text>
          <View style={[styles.toggleContainer, { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border }]}>
            <Pressable
              onPress={() => onToggleAppearance("dark")}
              style={[
                styles.toggleButton,
                appearance === "dark" && { backgroundColor: theme.colors.surface0 },
              ]}
            >
              <Icon name="Moon" size={12} color={appearance === "dark" ? theme.colors.accent : theme.colors.foregroundMuted} />
              <Text
                style={[
                  styles.toggleText,
                  { color: appearance === "dark" ? theme.colors.foreground : theme.colors.foregroundMuted },
                ]}
              >
                Dark
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onToggleAppearance("light")}
              style={[
                styles.toggleButton,
                appearance === "light" && { backgroundColor: theme.colors.surface0 },
              ]}
            >
              <Icon name="Sun" size={12} color={appearance === "light" ? theme.colors.accent : theme.colors.foregroundMuted} />
              <Text
                style={[
                  styles.toggleText,
                  { color: appearance === "light" ? theme.colors.foreground : theme.colors.foregroundMuted },
                ]}
              >
                Light
              </Text>
            </Pressable>
          </View>
        </View>

        <Pressable
          onPress={onAutoMap}
          style={[styles.actionButton, { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border }]}
        >
          <Icon name="Wand2" size={12} color={theme.colors.foreground} />
          <Text style={[styles.actionButtonText, { color: theme.colors.foreground }]}>Auto-Map</Text>
        </Pressable>
      </View>

      {/* Available Palette Quick Selector */}
      {availableColors.length > 0 && (
        <View style={[styles.quickPaletteContainer, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border }]}>
          <Text style={[styles.quickPaletteLabel, { color: theme.colors.foregroundMuted }]}>
            Extracted Swatches ({availableColors.length}):
          </Text>
          <View style={styles.quickPaletteGrid}>
            {availableColors.slice(0, 24).map((color) => (
              <View key={color.id} style={styles.paletteChip}>
                <View style={[styles.chipDot, { backgroundColor: color.hex, borderColor: theme.colors.border }]} />
                <Text style={[styles.chipText, { color: theme.colors.foreground }]} numberOfLines={1}>
                  {color.shade ?? color.name}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Token List */}
      <View style={styles.tokenList}>
        {TOKEN_DEFINITIONS.map((def) => {
          const currentHex = tokens[def.key];
          return (
            <View
              key={def.key}
              style={[
                styles.tokenRow,
                { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
              ]}
            >
              <View style={styles.tokenInfo}>
                <View style={styles.tokenTitleRow}>
                  <View style={[styles.colorPreview, { backgroundColor: currentHex, borderColor: theme.colors.border }]} />
                  <Text style={[styles.tokenLabel, { color: theme.colors.foreground }]}>{def.label}</Text>
                </View>
                <Text style={[styles.tokenDescription, { color: theme.colors.foregroundMuted }]}>
                  {def.description}
                </Text>
              </View>

              {/* Hex Input & Quick Swatches */}
              <View style={styles.tokenInputGroup}>
                <View style={[styles.hexInputWrapper, { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border }]}>
                  <TextInput
                    value={currentHex}
                    onChangeText={(text) => onChangeToken(def.key, text)}
                    onBlur={() => {
                      const normalized = normalizeHex(currentHex);
                      if (normalized) onChangeToken(def.key, normalized);
                    }}
                    placeholder="#000000"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.hexInput, { color: theme.colors.foreground }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                {/* Quick Swatch Picks */}
                <View style={styles.rowSwatches}>
                  {availableColors.slice(0, 6).map((color) => (
                    <Pressable
                      key={color.id}
                      onPress={() => onChangeToken(def.key, color.hex)}
                      style={[
                        styles.miniSwatch,
                        { backgroundColor: color.hex, borderColor: theme.colors.border },
                        currentHex.toLowerCase() === color.hex.toLowerCase() && [
                          styles.activeMiniSwatch,
                          { borderColor: theme.colors.accent },
                        ],
                      ]}
                    />
                  ))}
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  appearanceGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  toggleContainer: {
    flexDirection: "row",
    borderRadius: 6,
    borderWidth: 1,
    padding: 2,
    gap: 2,
  },
  toggleButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  toggleText: {
    fontSize: 11,
    fontWeight: "500",
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  actionButtonText: {
    fontSize: 11,
    fontWeight: "500",
  },
  quickPaletteContainer: {
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
  },
  quickPaletteLabel: {
    fontSize: 10,
    fontWeight: "500",
  },
  quickPaletteGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  paletteChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 0.5,
  },
  chipText: {
    fontSize: 9,
    fontFamily: "monospace",
  },
  tokenList: {
    gap: 8,
  },
  tokenRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  tokenInfo: {
    flex: 1,
    marginRight: 12,
  },
  tokenTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 2,
  },
  colorPreview: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
  },
  tokenLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  tokenDescription: {
    fontSize: 10,
  },
  tokenInputGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  hexInputWrapper: {
    width: 80,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  hexInput: {
    fontSize: 11,
    fontFamily: "monospace",
    padding: 0,
  },
  rowSwatches: {
    flexDirection: "row",
    gap: 4,
  },
  miniSwatch: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
  },
  activeMiniSwatch: {
    borderWidth: 2,
    transform: [{ scale: 1.15 }],
  },
});

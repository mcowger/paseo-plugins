import { type FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  autoMapTokens,
  extractPalette,
  generatePluginCode,
} from "../shared/parser.js";
import { BUILTIN_PRESETS } from "../shared/presets.js";
import { themeStudioSettings } from "../shared/settings.js";
import type {
  ThemeAppearance,
  ThemeStudioTokens,
  ThemeTokenKey,
} from "../shared/theme-types.js";
import { liveTheme } from "./live-theme.js";
import { getStudioDraft, setStudioDraft } from "./studio-draft.js";
import { MiniPreview } from "./mini-preview.js";
import { TokenMapper } from "./token-mapper.js";

export const StudioSurface: FC<PluginSurfaceProps> = ({ theme, layout }) => {
  const settingsState = useSettings(themeStudioSettings);
  const initialValues = settingsState.status === "ready" ? settingsState.values : undefined;
  const initialDraft = useRef(getStudioDraft());

  const [rawInput, setRawInput] = useState<string>(
    initialDraft.current?.rawInput ?? initialValues?.rawInput ?? BUILTIN_PRESETS[0].rawInput ?? "",
  );
  const [appearance, setAppearance] = useState<ThemeAppearance>(
    initialDraft.current?.appearance ?? initialValues?.appearance ?? BUILTIN_PRESETS[0].appearance,
  );
  const [tokens, setTokens] = useState<ThemeStudioTokens>(
    initialDraft.current?.tokens ?? initialValues?.tokens ?? BUILTIN_PRESETS[0].tokens,
  );
  const [activePresetId, setActivePresetId] = useState<string>(
    initialDraft.current?.activePresetId ?? BUILTIN_PRESETS[0].id,
  );
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("My Custom Theme");
  const toast = useToast();

  // Parse palette whenever rawInput changes
  const palette = useMemo(() => extractPalette(rawInput), [rawInput]);

  useEffect(() => {
    if (settingsState.status !== "ready" || initialDraft.current) return;
    setRawInput(settingsState.values.rawInput);
    setAppearance(settingsState.values.appearance);
    setTokens(settingsState.values.tokens);
    setStudioDraft({
      rawInput: settingsState.values.rawInput,
      appearance: settingsState.values.appearance,
      tokens: settingsState.values.tokens,
      activePresetId: BUILTIN_PRESETS[0].id,
    });
  }, [settingsState.status, settingsState.status === "ready" ? settingsState.revision : null]);

  // Update live theme registration
  const syncLiveTheme = useCallback(
    (newTokens: ThemeStudioTokens, newAppearance: ThemeAppearance) => {
      liveTheme.update({
        id: "theme-studio-live",
        name: "Theme Studio (Live)",
        appearance: newAppearance,
        colors: newTokens,
      });
    },
    [],
  );

  // Sync on initial mount & updates
  useEffect(() => {
    syncLiveTheme(tokens, appearance);
  }, [tokens, appearance, syncLiveTheme]);

  const savedPresets = settingsState.status === "ready" ? settingsState.values.savedPresets : [];
  const handleSelectPreset = (presetId: string) => {
    const preset = [...BUILTIN_PRESETS, ...savedPresets].find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const nextRawInput = preset.rawInput ?? rawInput;
    setStudioDraft({
      rawInput: nextRawInput,
      appearance: preset.appearance,
      tokens: preset.tokens,
      activePresetId: preset.id,
    });
    setActivePresetId(preset.id);
    setAppearance(preset.appearance);
    setTokens(preset.tokens);
    if (preset.rawInput) setRawInput(preset.rawInput);
  };

  const handleRawInputChange = (text: string) => {
    const extracted = extractPalette(text);
    const autoApply = settingsState.status !== "ready" || settingsState.values.autoApply;
    const nextTokens = autoApply && extracted.colors.length > 0 ? autoMapTokens(extracted.colors, appearance) : tokens;
    setStudioDraft({ rawInput: text, appearance, tokens: nextTokens, activePresetId: "custom" });
    setRawInput(text);
    setActivePresetId("custom");
    if (autoApply && extracted.colors.length > 0) setTokens(nextTokens);
  };

  const handleChangeToken = (key: ThemeTokenKey, hex: string) => {
    const nextTokens = { ...tokens, [key]: hex };
    setStudioDraft({ rawInput, appearance, tokens: nextTokens, activePresetId: "custom" });
    setActivePresetId("custom");
    setTokens(nextTokens);
  };

  const handleToggleAppearance = (newAppearance: ThemeAppearance) => {
    const autoApply = settingsState.status !== "ready" || settingsState.values.autoApply;
    const nextTokens = autoApply && palette.colors.length > 0 ? autoMapTokens(palette.colors, newAppearance) : tokens;
    setStudioDraft({ rawInput, appearance: newAppearance, tokens: nextTokens, activePresetId });
    setAppearance(newAppearance);
    if (autoApply && palette.colors.length > 0) setTokens(nextTokens);
  };

  const handleAutoMap = () => {
    if (palette.colors.length > 0) {
      const mapped = autoMapTokens(palette.colors, appearance);
      setStudioDraft({ rawInput, appearance, tokens: mapped, activePresetId });
      setTokens(mapped);
    }
  };

  const handleSave = async () => {
    if (settingsState.status !== "ready") return;
    const saved = await settingsState.save(
      { ...settingsState.values, rawInput, appearance, tokens },
      settingsState.revision,
    );
    if (saved) toast.show("Theme saved", { variant: "success" });
  };

  const handleSavePreset = async () => {
    if (settingsState.status !== "ready") return;
    const name = presetName.trim() || "My Custom Theme";
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom-theme";
    const ids = new Set(settingsState.values.savedPresets.map((preset) => preset.id));
    let id = baseId;
    let suffix = 2;
    while (ids.has(id)) id = `${baseId}-${suffix++}`;
    const saved = await settingsState.save(
      {
        ...settingsState.values,
        rawInput,
        appearance,
        tokens,
        savedPresets: [
          ...settingsState.values.savedPresets,
          { id, name, appearance, tokens, ...(rawInput.trim() ? { rawInput } : {}) },
        ],
      },
      settingsState.revision,
    );
    if (saved) toast.show("Preset saved", { variant: "success" });
  };

  const handleCopyCode = async () => {
    const code = generatePluginCode({
      id: "custom-theme",
      name: "My Custom Theme",
      appearance,
      tokens,
    });
    try {
      await copyText(code);
      toast.show("Plugin code copied to clipboard", { variant: "success" });
    } catch {
      // Fallback
    }
    setCopyFeedback("Plugin code copied!");
    setTimeout(() => setCopyFeedback(null), 2500);
  };

  const isStacked = layout.compact;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.colors.surface0 }]}
      contentContainerStyle={styles.content}
    >
      {/* Header Bar */}
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <View style={styles.headerTitleGroup}>
          <View style={[styles.iconBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Icon name="Palette" size={18} color={theme.colors.accent} />
          </View>
          <View>
            <Text style={[styles.title, { color: theme.colors.foreground }]}>Theme Studio</Text>
            <Text style={[styles.subtitle, { color: theme.colors.foregroundMuted }]}>
              Live Tailwind & CSS theme generator for Paseo
            </Text>
          </View>
        </View>

        {/* Live Host Status Notice */}
        <View style={[styles.hostNotice, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border }]}>
          <View style={[styles.pulseDot, { backgroundColor: theme.colors.statusSuccess }]} />
          <Text style={[styles.hostNoticeText, { color: theme.colors.foregroundMuted }]}>
            Active Theme: <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Theme Studio (Live)</Text>
          </Text>
        </View>
      </View>

      {/* Preset Pills */}
      <View style={styles.presetsSection}>
        <Text style={[styles.sectionLabel, { color: theme.colors.foregroundMuted }]}>Presets:</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetsList}>
          {[...BUILTIN_PRESETS, ...savedPresets].map((preset) => {
            const isSelected = activePresetId === preset.id;
            return (
              <Pressable
                key={preset.id}
                onPress={() => handleSelectPreset(preset.id)}
                style={[
                  styles.presetPill,
                  { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
                  isSelected && [styles.selectedPresetPill, { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 }],
                ]}
              >
                <View style={[styles.presetDot, { backgroundColor: preset.tokens.accent }]} />
                <Text
                  style={[
                    styles.presetPillText,
                    { color: isSelected ? theme.colors.foreground : theme.colors.foregroundMuted },
                  ]}
                >
                  {preset.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Main Studio Grid */}
      <View style={[styles.grid, isStacked ? styles.stackedGrid : styles.splitGrid]}>
        {/* Left Column: Input & Token Mapper */}
        <View style={styles.leftColumn}>
          {/* Raw Palette Input Card */}
          <View style={[styles.card, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border }]}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleRow}>
                <Icon name="Code" size={14} color={theme.colors.foreground} />
                <Text style={[styles.cardTitle, { color: theme.colors.foreground }]}>
                  Palette Input (Tailwind / CSS Variables)
                </Text>
              </View>
              <View style={[styles.formatBadge, { backgroundColor: theme.colors.surface2 }]}>
                <Text style={[styles.formatBadgeText, { color: theme.colors.accent }]}>
                  {palette.format === "tailwind"
                    ? `Tailwind (${palette.groups.length} families)`
                    : palette.format === "css"
                      ? `CSS Variables (${palette.colors.length})`
                      : palette.format === "hex-list"
                        ? `Hex List (${palette.colors.length})`
                        : "Empty"}
                </Text>
              </View>
            </View>

            <TextInput
              multiline
              value={rawInput}
              onChangeText={handleRawInputChange}
              placeholder="Paste Tailwind color objects or CSS variables here..."
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[
                styles.codeInput,
                {
                  backgroundColor: theme.colors.surface0,
                  borderColor: theme.colors.border,
                  color: theme.colors.foreground,
                },
              ]}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {/* Token Mapper Card */}
          <View style={[styles.card, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border }]}>
            <TokenMapper
              theme={theme}
              tokens={tokens}
              appearance={appearance}
              availableColors={palette.colors}
              onChangeToken={handleChangeToken}
              onToggleAppearance={handleToggleAppearance}
              onAutoMap={handleAutoMap}
            />
          </View>
        </View>

        {/* Right Column: Live Mini Preview & Export */}
        <View style={styles.rightColumn}>
          {/* Live Mini Preview Card */}
          <View style={[styles.card, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border }]}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleRow}>
                <Icon name="Eye" size={14} color={theme.colors.foreground} />
                <Text style={[styles.cardTitle, { color: theme.colors.foreground }]}>
                  Inline Live Preview
                </Text>
              </View>
              <Text style={[styles.previewHint, { color: theme.colors.foregroundMuted }]}>
                Simulated Paseo UI
              </Text>
            </View>

            <MiniPreview tokens={tokens} appearance={appearance} compact={isStacked} />
          </View>

          {/* Export & Actions Card */}
          <View style={[styles.card, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border }]}>
            <View style={styles.cardHeader}>
              <View style={styles.cardTitleRow}>
                <Icon name="Share2" size={14} color={theme.colors.foreground} />
                <Text style={[styles.cardTitle, { color: theme.colors.foreground }]}>
                  Export Theme
                </Text>
              </View>
              {copyFeedback && (
                <Text style={[styles.copyFeedbackText, { color: theme.colors.statusSuccess }]}>
                  {copyFeedback}
                </Text>
              )}
            </View>

            <TextInput
              value={presetName}
              onChangeText={setPresetName}
              placeholder="Preset name"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.presetInput, { color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border }]}
              autoCapitalize="words"
            />
            <Pressable
              onPress={() => void handleSavePreset()}
              disabled={settingsState.status !== "ready" || settingsState.saving}
              style={[styles.secondaryActionButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 }]}
            >
              <Icon name="BookmarkPlus" size={14} color={theme.colors.foreground} />
              <Text style={[styles.secondaryActionText, { color: theme.colors.foreground }]}>Save Preset</Text>
            </Pressable>
            <Text style={[styles.exportDesc, { color: theme.colors.foregroundMuted }]}>
              Export your palette as a standalone Paseo theme plugin or copy the token definitions.
            </Text>

            {settingsState.status === "ready" ? (
              <SettingsSwitch
                label="Auto-map pasted colors"
                hint="Map extracted colors into semantic tokens as you type."
                value={settingsState.values.autoApply}
                disabled={settingsState.saving}
                onValueChange={(value) =>
                  void settingsState.save({ ...settingsState.values, autoApply: value }, settingsState.revision)
                }
              />
            ) : null}
            <View style={styles.actionButtonsRow}>
              <Pressable
                onPress={() => void handleSave()}
                style={[styles.secondaryActionButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 }]}
              >
                <Icon name="Save" size={14} color={theme.colors.foreground} />
                <Text style={[styles.secondaryActionText, { color: theme.colors.foreground }]}>Save Theme</Text>
              </Pressable>
              <Pressable
                onPress={handleCopyCode}
                style={[
                  styles.primaryActionButton,
                  { backgroundColor: theme.colors.accent },
                ]}
              >
                <Icon name="Copy" size={14} color={theme.colors.surface0} />
                <Text style={[styles.primaryActionText, { color: theme.colors.surface0 }]}>
                  Copy Plugin Code
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 12,
    borderBottomWidth: 1,
    flexWrap: "wrap",
    gap: 10,
  },
  headerTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
  },
  subtitle: {
    fontSize: 12,
  },
  hostNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  hostNoticeText: {
    fontSize: 11,
  },
  presetsSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  presetsList: {
    flexDirection: "row",
    gap: 6,
  },
  presetPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
  },
  selectedPresetPill: {
    borderWidth: 1.5,
  },
  presetDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  presetPillText: {
    fontSize: 11,
    fontWeight: "500",
  },
  grid: {
    gap: 16,
  },
  splitGrid: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  stackedGrid: {
    flexDirection: "column",
  },
  leftColumn: {
    flex: 1,
    gap: 16,
  },
  rightColumn: {
    flex: 1,
    gap: 16,
  },
  card: {
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
  },
  formatBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  formatBadgeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  previewHint: {
    fontSize: 10,
  },
  codeInput: {
    minHeight: 140,
    maxHeight: 220,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    fontSize: 11,
    fontFamily: "monospace",
    textAlignVertical: "top",
  },
  exportDesc: {
    fontSize: 11,
    lineHeight: 16,
  },
  actionButtonsRow: {
    flexDirection: "row",
    gap: 8,
  },
  presetInput: {
    minHeight: 38,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
  },
  secondaryActionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  secondaryActionText: {
    fontSize: 12,
    fontWeight: "600",
  },
  primaryActionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    flex: 1,
  },
  primaryActionText: {
    fontSize: 12,
    fontWeight: "600",
  },
  copyFeedbackText: {
    fontSize: 11,
    fontWeight: "600",
  },
});

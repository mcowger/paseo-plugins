import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";

import {
  autoMapTokens,
  extractPalette,
  generatePluginCode,
  normalizeHex,
} from "../shared/parser.js";
import {
  themeStudioSettings,
  type ThemeStudioSettings as ThemeStudioSettingsValue,
} from "../shared/settings.js";
import type { ThemeAppearance, ThemeStudioPreset, ThemeStudioTokens } from "../shared/theme-types.js";

type ReadySettings = Extract<SettingsState<typeof themeStudioSettings.schema>, { status: "ready" }>;

const APPEARANCE_OPTIONS = [
  { label: "Dark", value: "dark" },
  { label: "Light", value: "light" },
] as const;

const TOKEN_FIELDS: { key: keyof ThemeStudioTokens; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Foreground" },
  { key: "raised", label: "Raised surface" },
  { key: "control", label: "Control" },
  { key: "border", label: "Border" },
  { key: "ring", label: "Focus ring" },
  { key: "mutedForeground", label: "Muted foreground" },
  { key: "accent", label: "Accent" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function presetId(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "custom-theme";
}

function findUniquePresetId(name: string, presets: readonly ThemeStudioPreset[]): string {
  const base = presetId(name);
  const ids = new Set(presets.map((preset) => preset.id));
  if (!ids.has(base)) return base;
  let index = 2;
  while (ids.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function pluginJson(options: {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  tokens: ThemeStudioTokens;
}): string {
  return JSON.stringify(
    {
      id: options.id,
      name: options.name,
      appearance: options.appearance,
      colors: options.tokens,
    },
    null,
    2,
  );
}

function TokenEditor({
  tokens,
  disabled,
  theme,
  onChange,
}: {
  tokens: ThemeStudioTokens;
  disabled: boolean;
  theme: PluginSurfaceProps["theme"];
  onChange(tokens: ThemeStudioTokens): void;
}) {
  const update = (key: keyof ThemeStudioTokens, value: string) => {
    onChange({ ...tokens, [key]: value });
  };
  return (
    <SettingsSection title="Theme tokens" info="Use 3-, 6-, or 8-digit hex colors.">
      <SettingsCard>
        {TOKEN_FIELDS.map(({ key, label }) => (
          <SettingsRow
            key={key}
            label={label}
            error={normalizeHex(tokens[key]) ? null : "Enter a valid hex color"}
          >
            <TextInput
              accessibilityLabel={label}
              value={tokens[key]}
              onChangeText={(value) => update(key, value)}
              editable={!disabled}
              autoCapitalize="none"
              style={{
                minHeight: 42,
                padding: 10,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                color: tokens.foreground,
              }}
            />
          </SettingsRow>
        ))}
      </SettingsCard>
      <Text style={{ color: tokens.foreground }}>
        These semantic tokens are expanded into Paseo's complete theme palette.
      </Text>
    </SettingsSection>
  );
}

function ThemePreview({ appearance, tokens }: { appearance: ThemeAppearance; tokens: ThemeStudioTokens }) {
  return (
    <SettingsSection title="Preview">
      <View
        style={{
          gap: 8,
          borderWidth: 1,
          borderColor: tokens.border,
          borderRadius: 10,
          padding: 14,
          backgroundColor: tokens.background,
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 18, fontWeight: "600" }}>
          {appearance === "dark" ? "Dark" : "Light"} theme preview
        </Text>
        <Text style={{ color: tokens.mutedForeground }}>
          Surfaces, controls, borders, and accents use your mapped tokens.
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1, height: 32, borderRadius: 6, backgroundColor: tokens.raised }} />
          <View style={{ flex: 1, height: 32, borderRadius: 6, backgroundColor: tokens.control }} />
          <View style={{ flex: 1, height: 32, borderRadius: 6, backgroundColor: tokens.accent }} />
        </View>
      </View>
    </SettingsSection>
  );
}

function ThemeStudioControls({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const toast = useToast();
  const [rawInput, setRawInput] = useState(settings.values.rawInput);
  const [appearance, setAppearance] = useState<ThemeAppearance>(settings.values.appearance);
  const [tokens, setTokens] = useState<ThemeStudioTokens>(settings.values.tokens);
  const [themeName, setThemeName] = useState("My Paseo theme");
  const [exportMode, setExportMode] = useState<"plugin" | "json">("plugin");
  const [exportText, setExportText] = useState("");

  useEffect(() => {
    setRawInput(settings.values.rawInput);
    setAppearance(settings.values.appearance);
    setTokens(settings.values.tokens);
  }, [settings.revision]);

  const palette = useMemo(() => extractPalette(rawInput), [rawInput]);
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger },
      input: {
        minHeight: 130,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        textAlignVertical: "top" as const,
      },
    }),
    [theme],
  );

  const updateSettings = async (patch: Partial<ThemeStudioSettingsValue>) => {
    const saved = await settings.save({ ...settings.values, ...patch }, settings.revision);
    if (saved) toast.show("Theme Studio settings saved", { variant: "success" });
  };

  const mapPalette = () => {
    setTokens(autoMapTokens(palette.colors, appearance));
    toast.show(palette.colors.length ? `Mapped ${palette.colors.length} colors` : "Using default palette", {
      variant: "info",
    });
  };

  const saveTheme = () => {
    void updateSettings({ rawInput, appearance, tokens });
  };

  const savePreset = async () => {
    const preset: ThemeStudioPreset = {
      id: findUniquePresetId(themeName, settings.values.savedPresets),
      name: themeName.trim() || "My Paseo theme",
      appearance,
      tokens,
      ...(rawInput.trim() ? { rawInput } : {}),
    };
    await updateSettings({
      rawInput,
      appearance,
      tokens,
      savedPresets: [...settings.values.savedPresets, preset],
    });
  };

  const exportTheme = () => {
    const id = presetId(themeName);
    setExportText(
      exportMode === "plugin"
        ? generatePluginCode({ id, name: themeName.trim() || "My Paseo theme", appearance, tokens })
        : pluginJson({ id, name: themeName.trim() || "My Paseo theme", appearance, tokens }),
    );
  };

  const copyExport = () => {
    void copyText(exportText)
      .then(() => toast.show("Copied to clipboard", { variant: "success" }))
      .catch((error: unknown) => toast.error(errorMessage(error)));
  };

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
      <SettingsSection title="Theme Studio" info="Paste a palette, map it to Paseo tokens, then save or export it.">
        <SettingsCard>
          <SettingsRow label="Palette input" hint="Tailwind objects, CSS variables, JSON, or loose hex colors.">
            <TextInput
              accessibilityLabel="Palette input"
              value={rawInput}
              onChangeText={setRawInput}
              multiline
              numberOfLines={7}
              editable={!settings.saving}
              placeholder="Paste palette colors here"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
          </SettingsRow>
          <Text style={styles.muted}>
            Detected {palette.colors.length} colors · {palette.format === "empty" ? "no palette" : palette.format}
          </Text>
          <SettingsSelect
            label="Appearance"
            value={appearance}
            options={APPEARANCE_OPTIONS}
            disabled={settings.saving}
            onValueChange={(value) => {
              const next = value as ThemeAppearance;
              setAppearance(next);
              if (settings.values.autoApply) setTokens(autoMapTokens(palette.colors, next));
            }}
          />
          <SettingsSwitch
            label="Auto-map while changing appearance"
            hint="Update tokens when switching between dark and light."
            value={settings.values.autoApply}
            disabled={settings.saving}
            onValueChange={(value) => void updateSettings({ autoApply: value })}
          />
          <SettingsAction label="Palette mapping" actionLabel="Map colors" onPress={mapPalette} disabled={settings.saving} />
          <SettingsAction label="Save current theme" actionLabel="Save" onPress={saveTheme} disabled={settings.saving} />
          {settings.saveError ? <Text accessibilityRole="alert" style={styles.error}>{settings.saveError}</Text> : null}
        </SettingsCard>
      </SettingsSection>

      <TokenEditor tokens={tokens} disabled={settings.saving} theme={theme} onChange={setTokens} />
      <ThemePreview appearance={appearance} tokens={tokens} />

      <SettingsSection title="Saved presets">
        <SettingsCard>
          <SettingsInput
            label="Preset name"
            initialValue={themeName}
            onChangeText={setThemeName}
            disabled={settings.saving}
          />
          <SettingsAction label="Save a copy" actionLabel="Add preset" onPress={() => void savePreset()} disabled={settings.saving} />
          {settings.values.savedPresets.map((preset) => (
            <SettingsAction
              key={preset.id}
              label={preset.name}
              hint={`${preset.appearance} · ${preset.tokens.accent}`}
              actionLabel="Load"
              disabled={settings.saving}
              onPress={() => {
                setThemeName(preset.name);
                setAppearance(preset.appearance);
                setTokens(preset.tokens);
                if (preset.rawInput !== undefined) setRawInput(preset.rawInput);
              }}
            />
          ))}
          {settings.values.savedPresets.length === 0 ? <Text style={styles.muted}>No custom presets saved yet.</Text> : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Export">
        <SettingsCard>
          <SettingsSelect
            label="Format"
            value={exportMode}
            options={[
              { label: "Paseo plugin", value: "plugin" },
              { label: "Theme JSON", value: "json" },
            ]}
            onValueChange={(value) => setExportMode(value as "plugin" | "json")}
          />
          <SettingsAction label="Generated output" actionLabel="Generate" onPress={exportTheme} />
          {exportText ? (
            <>
              <TextInput accessibilityLabel="Generated theme code" value={exportText} multiline editable={false} style={styles.input} />
              <SettingsAction label="Generated output" actionLabel="Copy" onPress={copyExport} />
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}

export function ThemeStudioSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(themeStudioSettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  if (settings.status === "loading") return <Text style={textStyle}>Loading Theme Studio…</Text>;
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <SettingsSection title="Theme Studio">
        <Text accessibilityRole="alert" style={textStyle}>{settings.error}</Text>
        <SettingsAction label="Stored settings" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? <SettingsAction label="Stored settings" actionLabel="Reset" onPress={settings.reset} /> : null}
      </SettingsSection>
    );
  }
  return <ThemeStudioControls settings={settings} theme={theme} />;
}

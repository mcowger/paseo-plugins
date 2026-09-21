import { useMemo } from "react";
import { Text } from "react-native";
import {
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { activitySettings, DEFAULT_EXPANSION, EXPANSION_TARGETS, expansionModeSchema, paletteModeSchema } from "../shared/settings";
import type { ExpansionMode, ExpansionTarget } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof activitySettings.schema>, { status: "ready" }>;

const paletteOptions = [
  { value: "vivid", label: "Vivid" },
  { value: "soft", label: "Soft" },
  { value: "high_contrast", label: "High contrast" },
];

const paletteDescriptions = {
  vivid: "Restrained category accents with neutral activity rows.",
  soft: "Mostly neutral icons with color reserved for status.",
  high_contrast: "Stronger dividers and status colors for easier scanning.",
} as const;

const expansionOptions = [
  { value: "always", label: "Always" },
  { value: "latest", label: "Latest" },
  { value: "never", label: "Never" },
];

const expansionDescriptions = {
  always: "Rows start expanded, even when they are not the newest.",
  latest: "Only the newest row of any kind starts expanded.",
  never: "Rows start collapsed, even while they are still running.",
} as const;

function ExpansionControls({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const descriptionStyle = useMemo(
    () => ({ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }),
    [theme.colors.foregroundMuted],
  );
  const changeExpansion = (target: ExpansionTarget) => (value: string) => {
    const parsed = expansionModeSchema.safeParse(value);
    if (!parsed.success) return;
    const mode: ExpansionMode = parsed.data;
    void settings.save(
      { ...settings.values, expansion: { ...DEFAULT_EXPANSION, ...settings.values.expansion, [target]: mode } },
      settings.revision,
    );
  };
  return (
    <SettingsSection title="Row expansion">
      <SettingsCard>
        {EXPANSION_TARGETS.map((target) => {
          const mode = settings.values.expansion?.[target.key] ?? target.default;
          return (
            <SettingsSelect
              key={target.key}
              label={target.label}
              hint={expansionDescriptions[mode]}
              value={mode}
              options={expansionOptions}
              disabled={settings.saving}
              onValueChange={changeExpansion(target.key)}
            />
          );
        })}
      </SettingsCard>
      <SettingsRow label="Behavior">
        <Text style={descriptionStyle}>
          Always rows start expanded, Latest rows expand only while they are the newest row of any kind, and Never rows
          start collapsed even while running. Tapping a row always overrides its setting. Set Paseo's Tool call detail
          setting to Detailed so each call reaches the plugin separately.
        </Text>
      </SettingsRow>
    </SettingsSection>
  );
}

function ReadyControls({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const descriptionStyle = useMemo(
    () => ({ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }),
    [theme.colors.foregroundMuted],
  );
  const errorStyle = useMemo(
    () => ({ color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 }),
    [theme.colors.statusDanger],
  );
  const changePalette = (value: string) => {
    const parsed = paletteModeSchema.safeParse(value);
    if (!parsed.success) return;
    void settings.save({ ...settings.values, palette: parsed.data }, settings.revision);
  };
  return (
    <SettingsSection title="Activity display">
      <SettingsCard>
        <SettingsSelect
          label="Palette"
          hint={paletteDescriptions[settings.values.palette]}
          value={settings.values.palette}
          options={paletteOptions}
          disabled={settings.saving}
          onValueChange={changePalette}
        />
      </SettingsCard>
      <SettingsRow label="Behavior">
        <Text style={descriptionStyle}>
          Rows render with category accents and monospace technical metadata. Use Row expansion below to control which
          rows start open.
        </Text>
      </SettingsRow>
      {settings.saveError ? <Text accessibilityRole="alert" style={errorStyle}>{settings.saveError}</Text> : null}
    </SettingsSection>
  );
}

export function ActivitySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(activitySettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  if (settings.status === "loading") return <Text style={textStyle}>Loading settings…</Text>;
  if (settings.status === "error") {
    return (
      <SettingsSection title="Activity display">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="Settings" actionLabel="Reload" onPress={settings.reload} />
      </SettingsSection>
    );
  }
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Activity display">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="Stored settings" actionLabel="Reset" onPress={settings.reset} />
        <SettingsAction label="Stored settings" actionLabel="Reload" onPress={settings.reload} />
      </SettingsSection>
    );
  }
  return (
    <>
      <ReadyControls settings={settings} theme={theme} />
      <ExpansionControls settings={settings} theme={theme} />
    </>
  );
}

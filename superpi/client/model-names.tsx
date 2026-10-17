import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text } from "react-native";
import type { ModelNameStyle } from "../shared/settings";
import { modelNameStyleSchema, superpiSettings } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof superpiSettings.schema>, { status: "ready" }>;

const styleOptions = [
  { value: "full", label: "Full names" },
  { value: "short", label: "Short names" },
];

const styleHints = {
  full: "Show the full Plexus model names in the picker.",
  short:
    "Show the abbreviated server short names where advertised; other models keep their full names.",
} as const;

function ReadyControls({ settings }: { settings: ReadySettings }) {
  const changeStyle = (value: string) => {
    const parsed = modelNameStyleSchema.safeParse(value);
    if (!parsed.success) return;
    const modelNameStyle: ModelNameStyle = parsed.data;
    void settings.save({ ...settings.values, modelNameStyle }, settings.revision);
  };
  return (
    <SettingsSection title="Model names">
      <SettingsCard>
        <SettingsSelect
          label="Model names"
          hint={styleHints[settings.values.modelNameStyle]}
          value={settings.values.modelNameStyle}
          options={styleOptions}
          disabled={settings.saving}
          onValueChange={changeStyle}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export function ModelNameSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(superpiSettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  if (settings.status === "loading") return <Text style={textStyle}>Loading settings…</Text>;
  if (settings.status === "error") {
    return (
      <SettingsSection title="Model names">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="Settings" actionLabel="Reload" onPress={settings.reload} />
      </SettingsSection>
    );
  }
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Model names">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="Stored settings" actionLabel="Reset" onPress={settings.reset} />
        <SettingsAction label="Stored settings" actionLabel="Reload" onPress={settings.reload} />
      </SettingsSection>
    );
  }
  return <ReadyControls settings={settings} />;
}

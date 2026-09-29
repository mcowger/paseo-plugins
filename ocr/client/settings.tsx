import { useEffect, useMemo, useState } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import {
  DEFAULT_NEW_AGENT_INSTRUCTIONS,
  preferencesSettings,
  providerModelSchema,
} from "../shared/settings.js";

type ReadySettings = Extract<
  SettingsState<typeof preferencesSettings.schema>,
  { status: "ready" }
>;

function validateModel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = providerModelSchema.safeParse(trimmed);
  return parsed.success ? null : "Expected provider/model format, e.g. acme/gpt-5-mini.";
}

function PreferencesEditor({ settings }: { settings: ReadySettings }) {
  const [knownRevision, setKnownRevision] = useState(settings.revision);
  const [instructions, setInstructions] = useState(settings.values.newAgentInstructions);
  const [model, setModel] = useState(settings.values.defaultProviderModel ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.revision !== knownRevision) {
      setKnownRevision(settings.revision);
      setInstructions(settings.values.newAgentInstructions);
      setModel(settings.values.defaultProviderModel ?? "");
    }
  }, [settings.revision, settings.values, knownRevision]);

  const instructionsError = instructions.trim()
    ? null
    : "Instructions must not be empty; reset to restore the default.";
  const modelError = useMemo(() => validateModel(model), [model]);
  const canSave = !instructionsError && !modelError && !settings.saving;

  const handleSave = async () => {
    setSaved(false);
    if (!canSave) return;
    const trimmedModel = model.trim();
    const ok = await settings.save(
      {
        newAgentInstructions: instructions.trim(),
        defaultProviderModel: trimmedModel ? trimmedModel : undefined,
      },
      settings.revision,
    );
    if (ok) setSaved(true);
  };

  const handleReset = async () => {
    setSaved(false);
    await settings.reset();
  };

  const handleReload = async () => {
    setSaved(false);
    await settings.reload();
  };

  return (
    <SettingsSection title="OpenCodeReview">
      <SettingsCard>
        <SettingsInput
          label="New-agent instructions"
          initialValue={instructions}
          onChangeText={setInstructions}
          disabled={settings.saving}
          error={instructionsError ?? settings.saveError}
        />
        <SettingsInput
          label="Default provider/model (empty clears it)"
          initialValue={model}
          onChangeText={setModel}
          placeholder="provider/model"
          disabled={settings.saving}
          error={modelError ?? undefined}
        />
        <SettingsAction
          label="Save preferences"
          hint="Instructions always keep the selected findings appended; a saved default is only used when still available."
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={!canSave}
          onPress={() => void handleSave()}
        />
        {saved ? <Text>Preferences saved.</Text> : null}
        {settings.saveError && saved === false ? (
          <Text accessibilityRole="alert">
            {settings.saveError} Another client may have saved first; reload and retry.
          </Text>
        ) : null}
        <SettingsAction
          label={`Defaults: ${DEFAULT_NEW_AGENT_INSTRUCTIONS.slice(0, 80)}…`}
          actionLabel="Reset to defaults"
          disabled={settings.saving}
          onPress={() => void handleReset()}
        />
        <SettingsAction
          label="Discard unsaved edits"
          actionLabel="Reload"
          disabled={settings.saving}
          onPress={() => void handleReload()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export function OcrSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferencesSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="OpenCodeReview">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  return <PreferencesEditor settings={settings} />;
}

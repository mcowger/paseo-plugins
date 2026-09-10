import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { TextInput } from "@getpaseo/plugin/client/react-native";

import {
  PI_PROVIDER_ID,
  piPresetsSettings,
  syncPiPresetsRpc,
  type PiPresetDefinition,
} from "../shared/preset-settings.js";

const THINKING_OPTIONS = [
  { label: "Off", value: "off" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "XHigh", value: "xhigh" },
  { label: "Max", value: "max" },
] as const;

type ReadySettings = Extract<
  SettingsState<typeof piPresetsSettings.schema>,
  { status: "ready" }
>;

type PresetDraft = {
  id: string;
  name: string;
  model: string;
  thinkingLevel: PiPresetDefinition["thinkingLevel"];
  tools: string;
  appendSystemPrompt: string;
};

function toDraft(preset: PiPresetDefinition): PresetDraft {
  return {
    id: preset.id,
    name: preset.name,
    model: preset.model,
    thinkingLevel: preset.thinkingLevel,
    tools: preset.tools?.join("\n") ?? "",
    appendSystemPrompt: preset.appendSystemPrompt ?? "",
  };
}

function patternsFromText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function presetFromDraft(draft: PresetDraft): PiPresetDefinition {
  const tools = patternsFromText(draft.tools);
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    model: draft.model.trim(),
    thinkingLevel: draft.thinkingLevel,
    ...(tools.length > 0 ? { tools } : {}),
    ...(draft.appendSystemPrompt.trim()
      ? { appendSystemPrompt: draft.appendSystemPrompt.trim() }
      : {}),
  };
}

function newPresetId(presets: readonly PiPresetDefinition[]): string {
  const existing = new Set(presets.map((preset) => preset.id));
  let index = 1;
  while (existing.has(`preset-${index}`)) index += 1;
  return `preset-${index}`;
}

function presetSummary(preset: PiPresetDefinition): string {
  const tools = preset.tools === undefined ? "default tools" : `${preset.tools.length} tool patterns`;
  return `${preset.model} · ${preset.thinkingLevel} · ${tools}`;
}

function PresetEditor({
  settings,
  initialPreset,
  revision,
  isNew,
  theme,
  onClose,
}: {
  settings: ReadySettings;
  initialPreset: PiPresetDefinition;
  revision: string;
  isNew: boolean;
  theme: PluginSurfaceProps["theme"];
  onClose(): void;
}) {
  const [draft, setDraft] = useState(() => toDraft(initialPreset));
  const styles = useMemo(
    () => ({
      input: {
        minHeight: 120,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        textAlignVertical: "top" as const,
      },
      message: { color: theme.colors.statusDanger },
      hint: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );

  const update = <Key extends keyof PresetDraft>(key: Key, value: PresetDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  async function save() {
    const preset = presetFromDraft(draft);
    const presets = isNew
      ? [...settings.values.presets, preset]
      : settings.values.presets.map((candidate) =>
          candidate.id === initialPreset.id ? preset : candidate,
        );
    if (await settings.save({ presets }, revision)) onClose();
  }

  async function remove() {
    const presets = settings.values.presets.filter((preset) => preset.id !== initialPreset.id);
    if (await settings.save({ presets }, settings.revision)) onClose();
  }

  return (
    <SettingsSection title={isNew ? "New preset" : `Edit ${initialPreset.name}`}>
      <SettingsCard>
        <SettingsInput
          label="Name"
          hint="This is the label shown in the composer."
          initialValue={draft.name}
          onChangeText={(value) => update("name", value)}
          disabled={settings.saving}
          error={settings.saveError}
        />
        <SettingsInput
          label="Model"
          hint="Use the full pi model id, such as provider/model."
          placeholder="provider/model"
          initialValue={draft.model}
          onChangeText={(value) => update("model", value)}
          disabled={settings.saving}
        />
        <SettingsSelect
          label="Thinking level"
          value={draft.thinkingLevel}
          options={THINKING_OPTIONS}
          onValueChange={(value) => update("thinkingLevel", value)}
          disabled={settings.saving}
        />
        <SettingsRow
          label="Tool patterns"
          hint="One exact name or glob per line. Leave empty to keep pi's normal tools."
        >
          <TextInput
            accessibilityLabel="Tool patterns"
            value={draft.tools}
            onChangeText={(value) => update("tools", value)}
            placeholder="read\nbash\nmcp_*"
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            numberOfLines={4}
            editable={!settings.saving}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsRow
          label="Appended system prompt"
          hint="Applied to the model whenever this preset is active."
        >
          <TextInput
            accessibilityLabel="Appended system prompt"
            value={draft.appendSystemPrompt}
            onChangeText={(value) => update("appendSystemPrompt", value)}
            placeholder="Optional instructions for this preset"
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            numberOfLines={8}
            editable={!settings.saving}
            style={styles.input}
          />
        </SettingsRow>
        {settings.saveError ? (
          <Text accessibilityRole="alert" style={styles.message}>
            {settings.saveError}
          </Text>
        ) : null}
        <SettingsAction
          label="Save changes"
          actionLabel="Save preset"
          disabled={settings.saving}
          onPress={save}
        />
        {!isNew ? (
          <SettingsAction
            label="Delete preset"
            actionLabel="Delete"
            disabled={settings.saving}
            onPress={remove}
          />
        ) : null}
        <SettingsAction
          label="Discard changes"
          actionLabel="Cancel"
          disabled={settings.saving}
          onPress={onClose}
        />
      </SettingsCard>
      <Text style={styles.hint}>
        Presets are stored by Paseo and shared by clients connected to this host.
      </Text>
    </SettingsSection>
  );
}

export function PiPresetSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(piPresetsSettings);
  const sync = useRpc(syncPiPresetsRpc);
  const paseo = usePaseo();
  const [editing, setEditing] = useState<{
    preset: PiPresetDefinition;
    revision: string;
    isNew: boolean;
  } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const syncedRevision = useRef<string | null>(null);
  const inFlightRevision = useRef<string | null>(null);
  const settingsRevision = settings.status === "ready" ? settings.revision : null;
  const settingsValues = settings.status === "ready" ? settings.values : null;

  useEffect(() => {
    if (
      !settingsValues ||
      !settingsRevision ||
      syncedRevision.current === settingsRevision ||
      inFlightRevision.current === settingsRevision
    ) {
      return;
    }
    inFlightRevision.current = settingsRevision;
    setSyncError(null);
    let syncCompleted = false;
    void sync({
      revision: settingsRevision,
      previousRevision: syncedRevision.current,
      values: settingsValues,
    })
      .then((result) => {
        if (result.revision !== settingsRevision) {
          throw new Error("The Pi preset sync returned a different settings revision");
        }
        syncedRevision.current = result.revision;
        syncCompleted = true;
        return paseo.providers.refresh({ providers: [PI_PROVIDER_ID] });
      })
      .then(() => setRefreshError(null))
      .catch((error: unknown) => {
        if (syncCompleted) {
          setRefreshError(error instanceof Error ? error.message : String(error));
        } else {
          syncedRevision.current = null;
          setSyncError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        inFlightRevision.current = null;
      });
  }, [paseo, settingsRevision, settingsValues, sync]);

  const retryProviderRefresh = () => {
    setRefreshError(null);
    void paseo.providers
      .refresh({ providers: [PI_PROVIDER_ID] })
      .catch((error: unknown) => setRefreshError(error instanceof Error ? error.message : String(error)));
  };

  const styles = useMemo(
    () => ({
      secondary: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );

  if (settings.status === "loading") {
    return <Text style={styles.secondary}>Loading Pi presets…</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Pi presets">
        <Text accessibilityRole="alert" style={styles.error}>
          {settings.error}
        </Text>
        <SettingsAction label="Settings" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore defaults"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }

  if (editing) {
    return (
      <PresetEditor
        key={`${editing.preset.id}:${editing.revision}`}
        settings={settings}
        initialPreset={editing.preset}
        revision={editing.revision}
        isNew={editing.isNew}
        theme={theme}
        onClose={() => {
          setEditing(null);
          void settings.reload();
        }}
      />
    );
  }

  return (
    <>
      <SettingsSection title="Pi presets" info="Presets are host-wide Paseo settings.">
        <SettingsCard>
          {settings.values.presets.map((preset) => (
            <SettingsAction
              key={preset.id}
              label={preset.name}
              hint={presetSummary(preset)}
              actionLabel="Edit"
              onPress={() =>
                setEditing({ preset, revision: settings.revision, isNew: false })
              }
            />
          ))}
          <SettingsAction
            label="Create a reusable model configuration"
            actionLabel="Add preset"
            onPress={() =>
              setEditing({
                preset: {
                  id: newPresetId(settings.values.presets),
                  name: "New preset",
                  model: "",
                  thinkingLevel: "medium",
                },
                revision: settings.revision,
                isNew: true,
              })
            }
          />
        </SettingsCard>
        {settings.values.presets.length === 0 ? (
          <Text style={styles.secondary}>
            Add a preset here, then select it from the Pi composer mode menu.
          </Text>
        ) : null}
        {syncError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            Could not sync presets with the Pi provider: {syncError}
          </Text>
        ) : null}
        {refreshError ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              Presets synced, but the provider catalog could not refresh: {refreshError}
            </Text>
            <SettingsAction
              label="Provider catalog"
              actionLabel="Retry refresh"
              onPress={retryProviderRefresh}
            />
          </>
        ) : null}
      </SettingsSection>
      <View>
        <Text style={styles.secondary}>
          Selecting a preset updates the session model, thinking level, tools, and appended prompt.
        </Text>
      </View>
    </>
  );
}

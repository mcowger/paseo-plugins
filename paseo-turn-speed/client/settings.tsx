import type { ComponentType } from "react";
import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { preferences, meterState, type Preferences } from "../shared/preferences";

export function makeSettingsScreen(onSaved: () => void): ComponentType<PluginSurfaceProps> {
  return function SpeedSettings({ theme, layout }: PluginSurfaceProps) {
    const settings = useSettings(preferences);
    const stateDoc = useSettings(meterState);
    const [manualDraft, setManualDraft] = useState("");
    const [rateDraft, setRateDraft] = useState("");

    const label = { color: theme.colors.foreground };
    const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
    const error = { color: theme.colors.statusDanger, fontSize: 12 };

    if (settings.status === "loading") {
      return <Text style={muted}>Loading settings…</Text>;
    }
    if (settings.status === "error" || settings.status === "invalid") {
      return (
        <View style={{ gap: 12 }}>
          <Text style={error}>{settings.error}</Text>
          <SettingsAction
            label="Retry"
            actionLabel="Reload settings"
            onPress={() => void settings.reload()}
          />
        </View>
      );
    }

    const values = settings.values;
    const save = (patch: Partial<Preferences>) => {
      void settings.save({ ...values, ...patch }, settings.revision).then((ok) => {
        if (ok) onSaved();
      });
    };

    const calibration =
      stateDoc.status === "ready" ? Object.entries(stateDoc.values.calibration) : [];
    const manualOn = values.manualCharsPerToken !== null;

    return (
      <View style={{ gap: layout.compact ? 16 : 24 }}>
        <SettingsSection title="Pill">
          <SettingsCard>
            <SettingsSwitch
              label="Show pills for idle agents"
              hint="Off keeps the composer track clean: pills appear only while a turn runs or right after it."
              value={values.showIdlePills}
              onValueChange={(v) => save({ showIdlePills: v })}
            />
            <SettingsSelect
              label="Speed basis"
              hint="Live estimates the running call and falls back to decode windows; Decode averages decode windows only; Whole turn divides tokens by turn time (user waits excluded)."
              value={values.numerator}
              options={[
                { label: "Live decode (default)", value: "live" },
                { label: "Decode windows", value: "decode" },
                { label: "Whole turn", value: "turn" },
              ]}
              onValueChange={(v) => save({ numerator: v })}
            />
            <SettingsSelect
              label="Token format"
              value={values.tokenFormat}
              options={[
                { label: "Compact (1.2k)", value: "compact" },
                { label: "Grouped (1 240)", value: "plain" },
              ]}
              onValueChange={(v) => save({ tokenFormat: v })}
            />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Live estimate">
          <SettingsCard>
            <SettingsSelect
              label="Live smoothing window"
              hint="Tok/s is averaged over this window while a model call streams."
              value={String(values.liveWindowSec)}
              options={[
                { label: "1 second", value: "1" },
                { label: "2 seconds", value: "2" },
                { label: "5 seconds", value: "5" },
              ]}
              onValueChange={(v) => save({ liveWindowSec: Number(v) as 1 | 2 | 5 })}
            />
            <SettingsSwitch
              label="Manual chars per token"
              hint="Overrides auto-calibration for the live token estimate. Calibration keeps learning in the background."
              value={manualOn}
              onValueChange={(v) => save({ manualCharsPerToken: v ? (values.manualCharsPerToken ?? 3.6) : null })}
            />
            {manualOn ? (
              <SettingsInput
                label="Chars per token"
                hint="Typical values: 3–4 for English, 5–6 for Cyrillic text."
                initialValue={String(values.manualCharsPerToken ?? 3.6)}
                placeholder="3.6"
                onChangeText={setManualDraft}
              />
            ) : null}
            {manualOn ? (
              <SettingsAction
                label="Apply"
                actionLabel="Apply value"
                onPress={() => {
                  const parsed = Number.parseFloat(manualDraft.replace(",", "."));
                  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 12) {
                    save({ manualCharsPerToken: parsed });
                  }
                }}
              />
            ) : null}
            {settings.saveError ? <Text style={error}>{settings.saveError}</Text> : null}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Accuracy guard">
          <SettingsCard>
            <SettingsInput
              label="Implausible rate limit (tok/s)"
              hint="A step implying a faster decode than this is treated as late usage from a previous message and dropped from the turn instead of inflating the rate."
              initialValue={String(values.maxPlausibleTokPerSec)}
              placeholder="400"
              onChangeText={setRateDraft}
            />
            <SettingsAction
              label="Apply"
              actionLabel="Apply limit"
              onPress={() => {
                const parsed = Number.parseInt(rateDraft, 10);
                if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 100000) {
                  save({ maxPlausibleTokPerSec: parsed });
                }
              }}
            />
            {settings.saveError ? <Text style={error}>{settings.saveError}</Text> : null}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection
          title="Prompt cache"
          info="Hit rate = cache reads / (new input + cache writes + cache reads), summed over the turn's model calls. Paseo does not report cache writes, so that term is currently always 0."
        >
          <SettingsCard>
            <SettingsSelect
              label="How cache reads are reported"
              hint="Auto infers the shape from the turn: one call whose cache reads exceed its prompt can only mean separate counters, and it decides for every call. Claude and OpenCode report cache reads on top of the prompt; most OpenAI-compatible providers fold them in."
              value={values.cacheCounting}
              options={[
                { label: "Auto (default)", value: "auto" },
                { label: "Included in prompt (OpenAI-style)", value: "inclusive" },
                { label: "Separate from prompt (Anthropic-style)", value: "separate" },
              ]}
              onValueChange={(v) => save({ cacheCounting: v })}
            />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Calibration" info="Learned per model from real usage: chars per output token, blended 0.7/0.3 and clamped to 2..8.">
          <SettingsCard>
            {calibration.length === 0 ? (
              <Text style={muted}>No measurements yet. Finish a turn with usage enabled.</Text>
            ) : (
              calibration.map(([model, cpt]) => (
                <View key={model} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                  <Text style={muted} numberOfLines={1}>
                    {model}
                  </Text>
                  <Text style={label}>{cpt.toFixed(2)} chars/tok</Text>
                </View>
              ))
            )}
          </SettingsCard>
        </SettingsSection>
      </View>
    );
  };
}

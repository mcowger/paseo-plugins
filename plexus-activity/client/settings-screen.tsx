import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import { Text, type TextStyle, View, type ViewStyle } from "react-native";
import { verifyRpc } from "../shared/rpc";
import { DEFAULT_BASE_URL, normalizeBaseUrl, plexusConfig } from "../shared/settings";
import { usePlexusKeys } from "./use-activity";

/**
 * Settings screen: the Plexus URL and the admin key.
 *
 * The key field is write-only. Paseo settings are host-side JSON rather than a credential vault, so the
 * value is never rendered back into the field, never returned by an RPC, and never logged.
 */

interface SettingsStyles {
  readonly hint: TextStyle;
  readonly status: TextStyle;
  readonly error: TextStyle;
  readonly stack: ViewStyle;
}

function createStyles(color: {
  muted: string;
  foreground: string;
  danger: string;
}): SettingsStyles {
  return {
    hint: { color: color.muted, fontSize: 11, lineHeight: 16 },
    status: { color: color.foreground, fontSize: 12 },
    error: { color: color.danger, fontSize: 11, lineHeight: 16 },
    stack: { gap: 2 },
  };
}

export function PlexusSettingsScreen({ theme }: PluginSurfaceProps): ReactElement {
  const styles = useMemo(
    () =>
      createStyles({
        muted: theme.colors.foregroundMuted,
        foreground: theme.colors.foreground,
        danger: theme.colors.statusDanger,
      }),
    [theme],
  );

  const settings = useSettings(plexusConfig);
  const keys = usePlexusKeys();
  const callVerify = useRpc(verifyRpc);
  const toast = useToast();

  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [scopeDraft, setScopeDraft] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [verifiedRole, setVerifiedRole] = useState<"admin" | "limited" | null>(null);

  const save = useCallback(async () => {
    if (settings.status !== "ready" || busy) return;

    const baseUrl = baseUrlDraft ?? settings.values.baseUrl;
    const adminKey = (keyDraft ?? settings.values.adminKey).trim();
    const defaultScope = scopeDraft === undefined ? settings.values.defaultScope : scopeDraft;

    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized.ok) {
      setFormError(normalized.error);
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      if (adminKey !== "") {
        const verified = await callVerify({ baseUrl: normalized.baseUrl, adminKey });
        if (!verified.ok) {
          setFormError(verified.error ?? "Plexus did not accept that admin key.");
          return;
        }
        setVerifiedRole(verified.role);
      }

      const saved = await settings.save(
        { baseUrl: normalized.baseUrl, adminKey, defaultScope },
        settings.revision,
      );

      if (!saved) {
        setFormError(
          settings.saveError ?? "The settings changed in another client. Reload and try again.",
        );
        return;
      }

      setBaseUrlDraft(null);
      setKeyDraft(null);
      setScopeDraft(undefined);
      keys.reload();
      toast.show("Plexus activity settings saved", { variant: "success" });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save the settings.");
    } finally {
      setBusy(false);
    }
  }, [baseUrlDraft, busy, callVerify, keyDraft, keys, scopeDraft, settings, toast]);

  const clearKey = useCallback(async () => {
    if (settings.status !== "ready" || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const saved = await settings.save({ ...settings.values, adminKey: "" }, settings.revision);
      if (!saved) {
        setFormError(settings.saveError ?? "Could not clear the admin key.");
        return;
      }
      setKeyDraft(null);
      setVerifiedRole(null);
      toast.show("Plexus admin key cleared");
    } finally {
      setBusy(false);
    }
  }, [busy, settings, toast]);

  if (settings.status === "loading") {
    return (
      <SettingsSection title="Plexus activity">
        <SettingsCard>
          <SettingsRow label="Loading">
            <Text style={styles.hint}>Reading the stored settings…</Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Plexus activity">
        <SettingsCard>
          <SettingsRow label="Settings are invalid">
            <View style={styles.stack}>
              <Text style={styles.error}>{settings.error}</Text>
              <SettingsAction
                label="Stored values"
                actionLabel="Reset to defaults"
                onPress={() => void settings.reset()}
              />
            </View>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (settings.status === "error") {
    return (
      <SettingsSection title="Plexus activity">
        <SettingsCard>
          <SettingsRow label="Settings unavailable">
            <View style={styles.stack}>
              <Text style={styles.error}>{settings.error}</Text>
              <SettingsAction
                label="Read again"
                actionLabel="Reload"
                onPress={() => void settings.reload()}
              />
            </View>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  const { values } = settings;
  const hasStoredKey = values.adminKey !== "";
  const scopeValue = scopeDraft === undefined ? (values.defaultScope ?? "") : (scopeDraft ?? "");
  const scopeOptions = [
    { label: "All keys", value: "" },
    ...keys.keys.map((key) => ({ label: key.name, value: key.name })),
  ];
  if (scopeValue !== "" && !scopeOptions.some((option) => option.value === scopeValue)) {
    scopeOptions.push({ label: scopeValue, value: scopeValue });
  }

  const keyStateLabel =
    keyDraft !== null
      ? "New key will be verified when you save."
      : hasStoredKey
        ? verifiedRole === "limited"
          ? "Stored key is a limited key: Plexus scopes the stream to it."
          : "Admin key stored."
        : "No admin key stored.";

  return (
    <View style={styles.stack}>
      <SettingsSection title="Connection">
        <SettingsCard>
          <SettingsInput
            key={`base-url-${settings.revision}`}
            label="Plexus URL"
            initialValue={values.baseUrl}
            placeholder={DEFAULT_BASE_URL}
            onChangeText={setBaseUrlDraft}
            disabled={busy}
            hint="Base URL of the Plexus server this daemon can reach, e.g. http://localhost:4000."
          />
          <SettingsInput
            key={`admin-key-${settings.revision}`}
            label="Admin key"
            initialValue=""
            placeholder={hasStoredKey ? "••••••••" : "Paste the Plexus admin key"}
            secureTextEntry
            onChangeText={setKeyDraft}
            disabled={busy}
            hint="Sent as the x-admin-key header. Stored on the host; never sent back to this screen."
          />
          <SettingsRow label="Key status">
            <Text style={styles.hint}>{keyStateLabel}</Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Display">
        <SettingsCard>
          <SettingsSelect
            label="Default scope"
            value={scopeValue}
            options={scopeOptions}
            onValueChange={(value) => setScopeDraft(value === "" ? null : value)}
            hint={
              keys.status === "ok"
                ? "Applied when the panel first opens. You can change it in the panel."
                : "Key list unavailable; pick a scope from the panel instead."
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Actions">
        <SettingsCard>
          <SettingsAction
            label="Save"
            actionLabel={busy ? "Saving…" : "Test & save"}
            onPress={() => void save()}
            disabled={busy}
            hint="Verifies the key with Plexus before storing it."
          />
          <SettingsAction
            label="Remove credential"
            actionLabel="Clear admin key"
            onPress={() => void clearKey()}
            disabled={busy || !hasStoredKey}
          />
        </SettingsCard>
      </SettingsSection>

      {formError !== null ? (
        <SettingsSection title="Problem">
          <SettingsCard>
            <SettingsRow label="Last error">
              <Text style={styles.error}>{formError}</Text>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </View>
  );
}

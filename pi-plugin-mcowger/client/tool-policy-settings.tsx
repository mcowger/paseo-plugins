import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { TextInput } from "@getpaseo/plugin/client/react-native";

import {
  getPiToolPolicyRevisionRpc,
  piToolPolicySettings,
  syncPiToolPolicyRpc,
  type PaseoHostToolPolicy,
  type PiToolPolicySettings,
} from "../shared/tool-policy.js";

const PASEO_TOOL_GROUPS: readonly {
  label: string;
  tools: readonly string[];
}[] = [
  {
    label: "Agent delegation",
    tools: [
      "create_agent", "send_agent_prompt", "wait_for_agent", "get_agent_status",
      "get_agent_activity", "cancel_agent", "archive_agent", "kill_agent", "update_agent", "set_agent_mode",
    ],
  },
  {
    label: "Workspaces and worktrees",
    tools: ["create_workspace", "list_workspaces", "rename_workspace", "archive_workspace"],
  },
  {
    label: "Terminals and workspace scripts",
    tools: [
      "list_workspace_scripts", "start_workspace_script", "stop_workspace_script",
      "list_terminals", "create_terminal", "kill_terminal", "capture_terminal", "send_terminal_keys",
    ],
  },
  {
    label: "Schedules and heartbeats",
    tools: [
      "create_schedule", "create_heartbeat", "delete_heartbeat", "list_schedules", "inspect_schedule",
      "pause_schedule", "resume_schedule", "delete_schedule", "update_schedule", "schedule_logs", "run_schedule_once",
    ],
  },
  {
    label: "Browser and voice",
    tools: [
      "browser_list_tabs", "browser_new_tab", "browser_snapshot", "browser_click", "browser_fill",
      "browser_wait", "browser_type", "browser_keypress", "browser_navigate", "browser_back",
      "browser_forward", "browser_reload", "browser_screenshot", "browser_upload", "browser_hover",
      "browser_select", "browser_drag", "browser_logs", "browser_evaluate", "browser_scroll",
      "browser_resize", "browser_close_tab", "speak",
    ],
  },
  {
    label: "Other host administration",
    tools: [
      "list_providers", "list_models", "list_profiles", "inspect_provider", "list_pending_permissions",
      "respond_to_permission", "list_agents",
    ],
  },
];

type ReadySettings = Extract<SettingsState<typeof piToolPolicySettings.schema>, { status: "ready" }>;

function patternsText(patterns: readonly string[]): string {
  return patterns.join("\n");
}

function patternsFromText(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((pattern) => pattern.trim()).filter(Boolean))];
}

function groupEnabled(policy: PaseoHostToolPolicy, tools: readonly string[]): boolean {
  return tools.every((tool) => !policy.disabledTools.includes(tool));
}

function updateGroup(policy: PaseoHostToolPolicy, tools: readonly string[], enabled: boolean): PaseoHostToolPolicy {
  const disabled = new Set(policy.disabledTools);
  for (const tool of tools) {
    if (enabled) disabled.delete(tool);
    else disabled.add(tool);
  }
  return { ...policy, disabledTools: [...disabled] };
}

const SYNC_RETRY_DELAYS_MS = [0, 250, 1000] as const;

function PolicyEditor({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const [draft, setDraft] = useState<PiToolPolicySettings>(settings.values);
  const [allowedPatternsText, setAllowedPatternsText] = useState(() => patternsText(settings.values.piTools.allowedPatterns));
  const [blockedPatternsText, setBlockedPatternsText] = useState(() => patternsText(settings.values.piTools.blockedPatterns));
  const [dirty, setDirty] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const styles = useMemo(() => ({
    input: {
      minHeight: 88,
      padding: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      textAlignVertical: "top" as const,
    },
    secondary: { color: theme.colors.foregroundMuted },
    error: { color: theme.colors.statusDanger },
  }), [theme]);

  useEffect(() => {
    if (!dirty) {
      setDraft(settings.values);
      setAllowedPatternsText(patternsText(settings.values.piTools.allowedPatterns));
      setBlockedPatternsText(patternsText(settings.values.piTools.blockedPatterns));
    }
  }, [dirty, settings.values]);

  const save = async () => {
    setSaveMessage(null);
    const values = {
      ...draft,
      piTools: {
        ...draft.piTools,
        allowedPatterns: patternsFromText(allowedPatternsText),
        blockedPatterns: patternsFromText(blockedPatternsText),
      },
    };
    const saved = await settings.save(values, settings.revision);
    if (saved) {
      setDirty(false);
      setSaveMessage("Saved. Refresh or reopen affected Pi agents to apply the policy.");
      await settings.reload();
    }
  };

  const setPi = (patch: Partial<PiToolPolicySettings["piTools"]>) => {
    setDraft((current) => ({ ...current, piTools: { ...current.piTools, ...patch } }));
    setDirty(true);
  };
  const setPaseo = (patch: Partial<PaseoHostToolPolicy>) => {
    setDraft((current) => ({ ...current, paseoTools: { ...current.paseoTools, ...patch } }));
    setDirty(true);
  };

  return <>
    <SettingsSection title="Pi tool access" info="These rules apply to the tools the Pi model can call.">
      <SettingsCard>
        <SettingsSelect
          label="Tool selection"
          value={draft.piTools.mode}
          options={[{ label: "Inherit Pi defaults", value: "inherit" }, { label: "Allow only matching tools", value: "allowlist" }]}
          onValueChange={(mode) => setPi({ mode })}
          disabled={settings.saving}
        />
        {draft.piTools.mode === "allowlist" ? <SettingsRow label="Allowed patterns" hint="One case-sensitive exact name or glob per line.">
          <TextInput accessibilityLabel="Allowed patterns" value={allowedPatternsText} onChangeText={(value) => { setAllowedPatternsText(value); setDirty(true); }} multiline numberOfLines={4} editable={!settings.saving} style={styles.input} placeholder="read\nfind\nmcp_paseo_get_agent_*" placeholderTextColor={theme.colors.foregroundMuted} />
        </SettingsRow> : null}
        <SettingsRow label="Blocked patterns" hint="Blocks always win. Glob matching is case-sensitive and uses minimatch.">
          <TextInput accessibilityLabel="Blocked patterns" value={blockedPatternsText} onChangeText={(value) => { setBlockedPatternsText(value); setDirty(true); }} multiline numberOfLines={4} editable={!settings.saving} style={styles.input} placeholder="bash\nmcp_linear_*" placeholderTextColor={theme.colors.foregroundMuted} />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection title="Paseo host tools" info="This is a model-facing catalog policy, not filesystem or shell sandboxing.">
      <SettingsCard>
        <SettingsSwitch label="Expose Paseo host tools" hint="Hiding create_workspace does not stop bash from running git worktree or the Paseo CLI." value={draft.paseoTools.enabled} onValueChange={(enabled) => setPaseo({ enabled })} disabled={settings.saving} />
        {PASEO_TOOL_GROUPS.map((group) => <SettingsSwitch key={group.label} label={group.label} value={groupEnabled(draft.paseoTools, group.tools)} onValueChange={(enabled) => setPaseo(updateGroup(draft.paseoTools, group.tools, enabled))} disabled={settings.saving || !draft.paseoTools.enabled} />)}
      </SettingsCard>
    </SettingsSection>

    <SettingsSection title="Effective behavior">
      <Text style={styles.secondary}>Paseo tools are removed before Pi registers them. Pi tool rules then narrow the active tools for every new Pi session. Changes apply after the affected agent is refreshed or reopened.</Text>
      <Text style={styles.secondary}>Pi Presets were removed. Use Paseo&apos;s ordinary composer controls for model and thinking choices.</Text>
      {settings.saveError ? <Text accessibilityRole="alert" style={styles.error}>{settings.saveError}</Text> : null}
      {saveMessage ? <Text style={styles.secondary}>{saveMessage}</Text> : null}
      <SettingsAction label="Save policy" actionLabel="Save" onPress={save} disabled={settings.saving || !dirty} />
      <SettingsAction label="Discard unsaved changes" actionLabel="Reload" onPress={() => { setDirty(false); void settings.reload(); }} disabled={settings.saving || !dirty} />
    </SettingsSection>
  </>;
}

export function PiToolPolicySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(piToolPolicySettings);
  const getRevision = useRpc(getPiToolPolicyRevisionRpc);
  const sync = useRpc(syncPiToolPolicyRpc);
  const syncedRevision = useRef<string | null>(null);
  const serverRevision = useRef<string | null | undefined>(undefined);
  const queuedRevision = useRef<string | null>(null);
  const syncQueue = useRef(Promise.resolve());
  const [syncError, setSyncError] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;
  const values = settings.status === "ready" ? settings.values : null;

  useEffect(() => {
    if (!values || !revision || syncedRevision.current === revision || queuedRevision.current === revision) return;
    const targetRevision = revision;
    const targetValues = values;
    queuedRevision.current = targetRevision;
    syncQueue.current = syncQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (syncedRevision.current === targetRevision) return;
        setSyncError(null);
        let lastError: unknown;
        for (const delayMs of SYNC_RETRY_DELAYS_MS) {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          try {
            if (serverRevision.current === undefined) {
              serverRevision.current = (await getRevision({})).revision;
            }
            const result = await sync({
              revision: targetRevision,
              previousRevision: serverRevision.current,
              values: targetValues,
            });
            if (result.revision !== targetRevision) {
              throw new Error("The Pi tool policy sync returned a different revision");
            }
            syncedRevision.current = result.revision;
            serverRevision.current = result.revision;
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      })
      .catch((error: unknown) => {
        syncedRevision.current = null;
        setSyncError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (queuedRevision.current === targetRevision) queuedRevision.current = null;
      });
  }, [getRevision, revision, sync, values]);

  const styles = useMemo(() => ({ secondary: { color: theme.colors.foregroundMuted }, error: { color: theme.colors.statusDanger } }), [theme]);
  if (settings.status === "loading") return <Text style={styles.secondary}>Loading Pi tool policy…</Text>;
  if (settings.status !== "ready") return <SettingsSection title="Pi tool policy"><Text accessibilityRole="alert" style={styles.error}>{settings.error}</Text><SettingsAction label="Settings" actionLabel="Reload" onPress={settings.reload} />{settings.status === "invalid" ? <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={settings.reset} /> : null}</SettingsSection>;
  return <View><PolicyEditor settings={settings} theme={theme} />{syncError ? <Text accessibilityRole="alert" style={styles.error}>Could not sync policy with the Pi provider: {syncError}</Text> : null}</View>;
}

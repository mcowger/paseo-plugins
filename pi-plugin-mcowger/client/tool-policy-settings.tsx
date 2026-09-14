import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
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
  createProfileToolPolicy,
  reconcileProfilePolicies,
  saveProfilePolicyWithRetry,
  withProfileLaunchSignature,
} from "./profile-policy-sync.js";
import {
  getPiToolPolicyKnownToolsRpc,
  getPiToolPolicyProfilesRpc,
  getPiToolPolicyRevisionRpc,
  piToolPolicySettings,
  syncPiToolPolicyProfileMarkersRpc,
  syncPiToolPolicyRpc,
  type PaseoHostToolPolicy,
  type PiKnownToolSummary,
  type PiProfileSummary,
  type PiToolPolicySettings,
  type ProfileToolPolicy,
} from "../shared/tool-policy.js";

export const PASEO_TOOL_GROUPS: readonly { label: string; tools: readonly string[] }[] = [
  { label: "Agent orchestration", tools: ["create_agent", "send_agent_prompt"] },
  { label: "Agent sessions", tools: ["get_agent_status", "list_agents", "get_agent_activity", "set_agent_mode", "cancel_agent", "archive_agent", "kill_agent", "update_agent"] },
  { label: "Workspaces and worktrees", tools: ["create_workspace", "list_workspaces", "rename_workspace", "archive_workspace"] },
  { label: "Terminals and workspace scripts", tools: ["list_workspace_scripts", "start_workspace_script", "stop_workspace_script", "list_terminals", "create_terminal", "kill_terminal", "capture_terminal", "send_terminal_keys"] },
  { label: "Schedules and heartbeats", tools: ["create_schedule", "list_schedules", "inspect_schedule", "update_schedule", "pause_schedule", "resume_schedule", "delete_schedule", "schedule_logs", "run_schedule_once", "create_heartbeat", "delete_heartbeat"] },
  { label: "Providers and profiles", tools: ["list_providers", "list_models", "inspect_provider", "list_profiles"] },
  { label: "Permissions", tools: ["list_pending_permissions", "respond_to_permission"] },
  { label: "Browser automation", tools: ["browser_list_tabs", "browser_new_tab", "browser_snapshot", "browser_click", "browser_fill", "browser_wait", "browser_type", "browser_keypress", "browser_navigate", "browser_back", "browser_forward", "browser_reload", "browser_screenshot", "browser_upload", "browser_hover", "browser_select", "browser_drag", "browser_logs", "browser_evaluate", "browser_scroll", "browser_resize", "browser_close_tab"] },
  { label: "Voice", tools: ["speak"] },
];

const SYNC_RETRY_DELAYS_MS = [0, 250, 1000] as const;

type ReadySettings = Extract<SettingsState<typeof piToolPolicySettings.schema>, { status: "ready" }>;
export type LoadState<Value> = { status: "loading" } | { status: "ready"; value: Value } | { status: "error"; error: string };

export function patternsText(patterns: readonly string[]): string {
  return patterns.join("\n");
}

export function patternsFromText(value: string): string[] {
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

function toggleAllowedTool(tools: readonly string[], tool: string, enabled: boolean): string[] {
  const selected = new Set(tools);
  if (enabled) selected.add(tool);
  else selected.delete(tool);
  return [...selected];
}

function updateAllowedGroup(policy: ProfileToolPolicy, tools: readonly string[], enabled: boolean): ProfileToolPolicy {
  let allowed = policy.allowedPaseoToolNames;
  for (const tool of tools) allowed = toggleAllowedTool(allowed, tool, enabled);
  return { ...policy, allowedPaseoToolNames: allowed };
}

function profilePolicyFor(values: PiToolPolicySettings, profileId: string): ProfileToolPolicy | undefined {
  return values.profilePolicies.find((policy) => policy.profileId === profileId);
}

function sourceLabel(tool: PiKnownToolSummary): string {
  if (!tool.source) return tool.baselineActive ? "Pi default" : "Available";
  const label = tool.source.label ? ` · ${tool.source.label}` : "";
  return `${tool.source.kind}${label}${tool.baselineActive ? " · Pi default" : ""}`;
}

function DisclosureHeader({
  label,
  summary,
  expanded,
  onPress,
  theme,
}: {
  label: string;
  summary: string;
  expanded: boolean;
  onPress(): void;
  theme: PluginSurfaceProps["theme"];
}) {
  const styles = useMemo(() => ({
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 8 },
    indicator: { color: theme.colors.foregroundMuted, fontSize: 16, width: 18 },
    label: { flex: 1, color: theme.colors.foreground, fontWeight: "600" as const },
    summary: { color: theme.colors.foregroundMuted, fontSize: 12 },
  }), [theme]);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label} section`} accessibilityState={{ expanded }} onPress={onPress} style={styles.header}>
    <Text style={styles.indicator}>{expanded ? "▾" : "▸"}</Text>
    <Text style={styles.label}>{label}</Text>
    <Text style={styles.summary}>{summary}</Text>
  </Pressable>;
}

function ProfilePolicyCard({
  profile,
  policy,
  theme,
  knownTools,
  knownToolsState,
  disabled,
  onChange,
  onRetryKnownTools,
}: {
  profile: PiProfileSummary;
  policy: ProfileToolPolicy | undefined;
  theme: PluginSurfaceProps["theme"];
  knownTools: readonly PiKnownToolSummary[];
  knownToolsState: LoadState<readonly PiKnownToolSummary[]>;
  disabled: boolean;
  onChange(policy: ProfileToolPolicy | undefined): void;
  onRetryKnownTools(): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [externalPatterns, setExternalPatterns] = useState(() => patternsText(policy?.allowedExternalMcpPatterns ?? []));
  const styles = useMemo(() => ({
    input: { minHeight: 88, padding: 10, borderWidth: 1, borderColor: "transparent", borderRadius: 8, textAlignVertical: "top" as const },
  }), []);

  useEffect(() => {
    const normalizedPolicy = patternsText(policy?.allowedExternalMcpPatterns ?? []);
    setExternalPatterns((current) => patternsText(patternsFromText(current)) === normalizedPolicy ? current : normalizedPolicy);
  }, [policy]);

  const enabled = policy !== undefined;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTools = knownTools.filter((tool) => !normalizedQuery || `${tool.name} ${tool.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery));
  const knownNames = new Set(knownTools.map((tool) => tool.name));
  const staleTools = policy?.allowedPiToolNames.filter((name) => !knownNames.has(name)) ?? [];

  const profileSummary = policy
    ? `Enabled · ${policy.allowedPiToolNames.length} Pi · ${policy.allowedPaseoToolNames.length} Paseo`
    : "Disabled · using fallback";

  if (!policy) {
    return <SettingsCard>
      <DisclosureHeader label={profile.name} summary={profileSummary} expanded={expanded} onPress={() => setExpanded((current) => !current)} theme={theme} />
      {expanded ? <SettingsSwitch
        label={profile.name}
        hint="Use the global fallback policy for this profile."
        value={false}
        onValueChange={(value) => onChange(value ? createProfileToolPolicy(profile) : undefined)}
        disabled={disabled}
      /> : null}
    </SettingsCard>;
  }

  const update = (patch: Partial<ProfileToolPolicy>) =>
    onChange(withProfileLaunchSignature({ ...policy, ...patch }, profile));
  const emptyPolicy = policy.allowedPiToolNames.length + policy.allowedPaseoToolNames.length + policy.allowedExternalMcpPatterns.length === 0;

  return <SettingsCard>
    <DisclosureHeader label={profile.name} summary={profileSummary} expanded={expanded} onPress={() => setExpanded((current) => !current)} theme={theme} />
    {expanded ? <>
    <SettingsSwitch
      label={profile.name}
      hint="Strict profile policy enabled. It replaces the global fallback for this profile."
      value={enabled}
      onValueChange={(value) => onChange(value ? policy : undefined)}
      disabled={disabled}
    />
    <SettingsRow label="Pi tools" hint="Select exact global Pi tool names. Project-local extensions are not included in this discovery.">
      {knownToolsState.status === "loading" ? <Text>Loading known Pi tools…</Text> : null}
      {knownToolsState.status === "error" ? <>
        <Text accessibilityRole="alert">Pi tool discovery is unavailable: {knownToolsState.error}. Saved selections are kept as stale entries.</Text>
        <SettingsAction label="Pi tool discovery" actionLabel="Retry" onPress={() => void onRetryKnownTools()} disabled={disabled} />
      </> : null}
      <TextInput accessibilityLabel={`${profile.name} Pi tool search`} value={query} onChangeText={setQuery} editable={!disabled} placeholder="Search Pi tools" />
      {visibleTools.map((tool) => <SettingsSwitch key={tool.name} label={tool.name} hint={sourceLabel(tool)} value={policy.allowedPiToolNames.includes(tool.name)} onValueChange={(value) => update({ allowedPiToolNames: toggleAllowedTool(policy.allowedPiToolNames, tool.name, value) })} disabled={disabled} />)}
      {knownToolsState.status === "ready" && visibleTools.length === 0 ? <Text>No known Pi tools match this search.</Text> : null}
      {staleTools.map((name) => <SettingsSwitch key={name} label={name} hint="Stale selection: unavailable from the current global Pi discovery." value onValueChange={(value) => { if (!value) update({ allowedPiToolNames: toggleAllowedTool(policy.allowedPiToolNames, name, false) }); }} disabled={disabled} />)}
    </SettingsRow>
    <SettingsRow label="Paseo host tools" hint="Canonical Paseo tool names only. Bridge aliases are never shown." />
    <View>
      {PASEO_TOOL_GROUPS.map((group) => {
        const selectedCount = group.tools.filter((tool) => policy.allowedPaseoToolNames.includes(tool)).length;
        const groupExpanded = expandedGroups[group.label] ?? false;
        return <View key={group.label}>
          <DisclosureHeader label={group.label} summary={`${selectedCount}/${group.tools.length} selected`} expanded={groupExpanded} onPress={() => setExpandedGroups((current) => ({ ...current, [group.label]: !groupExpanded }))} theme={theme} />
          {groupExpanded ? <>
            <SettingsSwitch label={group.label} value={selectedCount === group.tools.length} onValueChange={(value) => onChange(updateAllowedGroup(policy, group.tools, value))} disabled={disabled} />
            {group.tools.map((tool) => <SettingsSwitch key={tool} label={tool} value={policy.allowedPaseoToolNames.includes(tool)} onValueChange={(value) => update({ allowedPaseoToolNames: toggleAllowedTool(policy.allowedPaseoToolNames, tool, value) })} disabled={disabled} />)}
          </> : null}
        </View>;
      })}
    </View>
    <SettingsRow label="External MCP allow patterns" hint="Advanced: one case-sensitive minimatch pattern per line. These apply only to non-Paseo MCP tools.">
      <TextInput accessibilityLabel={`${profile.name} external MCP allow patterns`} value={externalPatterns} onChangeText={(value) => { setExternalPatterns(value); update({ allowedExternalMcpPatterns: patternsFromText(value) }); }} multiline numberOfLines={4} editable={!disabled} style={styles.input} />
    </SettingsRow>
    {emptyPolicy ? <Text accessibilityRole="alert">This enabled profile policy allows no tools. Agents using this profile will be chat-only.</Text> : null}
    <Text>Policy changes apply when an agent using this profile is opened or refreshed.</Text>
    </> : null}
  </SettingsCard>;
}

function PolicyEditor({ settings, theme, profilesState, knownToolsState, onRetryProfiles, onRetryKnownTools }: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
  profilesState: LoadState<readonly PiProfileSummary[]>;
  knownToolsState: LoadState<readonly PiKnownToolSummary[]>;
  onRetryProfiles(): Promise<void>;
  onRetryKnownTools(): Promise<void>;
}) {
  const [draft, setDraft] = useState<PiToolPolicySettings>(settings.values);
  const [allowedPatternsText, setAllowedPatternsText] = useState(() => patternsText(settings.values.piTools.allowedPatterns));
  const [blockedPatternsText, setBlockedPatternsText] = useState(() => patternsText(settings.values.piTools.blockedPatterns));
  const [dirty, setDirty] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [fallbackPiExpanded, setFallbackPiExpanded] = useState(false);
  const [fallbackPaseoExpanded, setFallbackPaseoExpanded] = useState(false);
  const [fallbackGroupsExpanded, setFallbackGroupsExpanded] = useState<Record<string, boolean>>({});
  const styles = useMemo(() => ({
    input: { minHeight: 88, padding: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface2, color: theme.colors.foreground, textAlignVertical: "top" as const },
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

  const setPi = (patch: Partial<PiToolPolicySettings["piTools"]>) => { setDraft((current) => ({ ...current, piTools: { ...current.piTools, ...patch } })); setDirty(true); };
  const setPaseo = (patch: Partial<PaseoHostToolPolicy>) => { setDraft((current) => ({ ...current, paseoTools: { ...current.paseoTools, ...patch } })); setDirty(true); };
  const setProfilePolicy = (profileId: string, policy: ProfileToolPolicy | undefined) => {
    setDraft((current) => ({ ...current, profilePolicies: policy ? [...current.profilePolicies.filter((entry) => entry.profileId !== profileId), policy] : current.profilePolicies.filter((entry) => entry.profileId !== profileId) }));
    setDirty(true);
  };
  const save = async () => {
    setSaveMessage(null);
    const values = { ...draft, piTools: { ...draft.piTools, allowedPatterns: patternsFromText(allowedPatternsText), blockedPatterns: patternsFromText(blockedPatternsText) } };
    const saved = await settings.save(
      profilesState.status === "ready" ? reconcileProfilePolicies(values, profilesState.value) : values,
      settings.revision,
    );
    if (saved) {
      setDirty(false);
      setSaveMessage("Saved. Refresh or reopen affected Pi agents to apply the policy.");
      await onRetryProfiles();
      await settings.reload();
    }
  };

  return <>
    <SettingsSection title="Fallback Pi tool access" info="This global policy is used only when a Pi agent profile has no strict policy.">
      <SettingsCard>
        <DisclosureHeader label="Fallback Pi policy" summary={`${draft.piTools.mode === "allowlist" ? "Allowlist" : "Inherit defaults"} · ${draft.piTools.blockedPatterns.length} blocked`} expanded={fallbackPiExpanded} onPress={() => setFallbackPiExpanded((current) => !current)} theme={theme} />
        {fallbackPiExpanded ? <>
          <SettingsSelect label="Tool selection" value={draft.piTools.mode} options={[{ label: "Inherit Pi defaults", value: "inherit" }, { label: "Allow only matching tools", value: "allowlist" }]} onValueChange={(mode) => setPi({ mode })} disabled={settings.saving} />
          {draft.piTools.mode === "allowlist" ? <SettingsRow label="Allowed patterns" hint="One case-sensitive exact name or glob per line."><TextInput accessibilityLabel="Fallback allowed patterns" value={allowedPatternsText} onChangeText={(value) => { setAllowedPatternsText(value); setDirty(true); }} multiline numberOfLines={4} editable={!settings.saving} style={styles.input} placeholder="read\nfind\ngrep" placeholderTextColor={theme.colors.foregroundMuted} /></SettingsRow> : null}
          <SettingsRow label="Blocked patterns" hint="Blocks always win. Glob matching is case-sensitive and uses minimatch."><TextInput accessibilityLabel="Fallback blocked patterns" value={blockedPatternsText} onChangeText={(value) => { setBlockedPatternsText(value); setDirty(true); }} multiline numberOfLines={4} editable={!settings.saving} style={styles.input} placeholder="bash\nmcp_linear_*" placeholderTextColor={theme.colors.foregroundMuted} /></SettingsRow>
        </> : null}
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Fallback Paseo host tools" info="This global catalog policy is the fallback, not a filesystem or shell sandbox.">
      <SettingsCard>
        <DisclosureHeader label="Fallback Paseo tools" summary={`${draft.paseoTools.enabled ? "Enabled" : "Disabled"} · ${PASEO_TOOL_GROUPS.reduce((count, group) => count + group.tools.filter((tool) => !draft.paseoTools.disabledTools.includes(tool)).length, 0)} selected`} expanded={fallbackPaseoExpanded} onPress={() => setFallbackPaseoExpanded((current) => !current)} theme={theme} />
        {fallbackPaseoExpanded ? <>
          <SettingsSwitch label="Expose Paseo host tools" hint="Hiding create_workspace does not stop bash from running git worktree or the Paseo CLI." value={draft.paseoTools.enabled} onValueChange={(enabled) => setPaseo({ enabled })} disabled={settings.saving} />
          {PASEO_TOOL_GROUPS.map((group) => {
            const selectedCount = group.tools.filter((tool) => !draft.paseoTools.disabledTools.includes(tool)).length;
            const groupExpanded = fallbackGroupsExpanded[group.label] ?? false;
            return <View key={group.label}>
              <DisclosureHeader label={group.label} summary={`${selectedCount}/${group.tools.length} enabled`} expanded={groupExpanded} onPress={() => setFallbackGroupsExpanded((current) => ({ ...current, [group.label]: !groupExpanded }))} theme={theme} />
              {groupExpanded ? <>
                <SettingsSwitch label={group.label} value={groupEnabled(draft.paseoTools, group.tools)} onValueChange={(enabled) => setPaseo(updateGroup(draft.paseoTools, group.tools, enabled))} disabled={settings.saving || !draft.paseoTools.enabled} />
                {group.tools.map((tool) => <SettingsSwitch key={tool} label={tool} value={!draft.paseoTools.disabledTools.includes(tool)} onValueChange={(enabled) => setPaseo(updateGroup(draft.paseoTools, [tool], enabled))} disabled={settings.saving || !draft.paseoTools.enabled} />)}
              </> : null}
            </View>;
          })}
        </> : null}
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Profile policies" info="A strict policy replaces the fallback for its saved Pi profile. Changes apply after an agent is opened or refreshed.">
      {profilesState.status === "loading" ? <Text style={styles.secondary}>Loading Pi profiles and synchronizing profile markers…</Text> : null}
      {profilesState.status === "error" ? <><Text accessibilityRole="alert" style={styles.error}>Profile policies are unavailable: {profilesState.error}. Saved profile rules were kept.</Text><SettingsAction label="Profile access" actionLabel="Retry" onPress={() => void onRetryProfiles()} disabled={settings.saving} /></> : null}
      {profilesState.status === "ready" && profilesState.value.length === 0 ? <Text style={styles.secondary}>No saved Pi-provider profiles are available. The fallback policy remains active.</Text> : null}
      {profilesState.status === "ready" ? profilesState.value.map((profile) => <ProfilePolicyCard key={profile.id} profile={profile} policy={profilePolicyFor(draft, profile.id)} theme={theme} knownTools={knownToolsState.status === "ready" ? knownToolsState.value : []} knownToolsState={knownToolsState} disabled={settings.saving} onChange={(policy) => setProfilePolicy(profile.id, policy)} onRetryKnownTools={onRetryKnownTools} />) : null}
    </SettingsSection>
    <SettingsSection title="Effective behavior">
      <Text style={styles.secondary}>Paseo tools are removed before Pi registers them. Fallback Pi rules narrow active tools for every new Pi session.</Text>
      <Text style={styles.secondary}>Profile policies and fallback changes apply after the affected agent is opened or refreshed.</Text>
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
  const getProfiles = useRpc(getPiToolPolicyProfilesRpc);
  const syncProfileMarkers = useRpc(syncPiToolPolicyProfileMarkersRpc);
  const getKnownTools = useRpc(getPiToolPolicyKnownToolsRpc);
  const [profilesState, setProfilesState] = useState<LoadState<readonly PiProfileSummary[]>>({ status: "loading" });
  const [knownToolsState, setKnownToolsState] = useState<LoadState<readonly PiKnownToolSummary[]>>({ status: "loading" });
  const syncedRevision = useRef<string | null>(null);
  const serverRevision = useRef<string | null | undefined>(undefined);
  const queuedRevision = useRef<string | null>(null);
  const syncQueue = useRef(Promise.resolve());
  const prunedRevision = useRef<string | null>(null);
  const pruningRevision = useRef<string | null>(null);
  const pruneFailureRevision = useRef<string | null>(null);
  const [pruneRetryNonce, setPruneRetryNonce] = useState(0);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;
  const values = settings.status === "ready" ? settings.values : null;

  const refreshProfiles = useCallback(async () => {
    setProfilesState({ status: "loading" });
    try {
      await getProfiles({});
      const synced = await syncProfileMarkers({});
      setProfilesState({ status: "ready", value: synced.profiles });
    } catch (error) {
      setProfilesState({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }, [getProfiles, syncProfileMarkers]);

  const refreshKnownTools = useCallback(async () => {
    setKnownToolsState({ status: "loading" });
    try {
      const result = await getKnownTools({});
      setKnownToolsState({ status: "ready", value: result.tools });
    } catch (error) {
      setKnownToolsState({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }, [getKnownTools]);

  useEffect(() => { void refreshProfiles(); }, [refreshProfiles]);
  useEffect(() => { void refreshKnownTools(); }, [refreshKnownTools]);
  useEffect(() => {
    if (
      settings.status !== "ready" ||
      profilesState.status !== "ready" ||
      prunedRevision.current === settings.revision ||
      pruningRevision.current === settings.revision ||
      pruneFailureRevision.current === settings.revision
    ) return;
    const reconciled = reconcileProfilePolicies(settings.values, profilesState.value);
    if (reconciled === settings.values) {
      prunedRevision.current = settings.revision;
      return;
    }
    const targetRevision = settings.revision;
    pruningRevision.current = targetRevision;
    let active = true;
    void saveProfilePolicyWithRetry(
      () => settings.save(reconciled, targetRevision),
      settings.reload,
    ).then(() => {
      if (!active) return;
      prunedRevision.current = targetRevision;
      pruneFailureRevision.current = null;
      setPruneError(null);
    }).catch((error: unknown) => {
      if (!active) return;
      pruneFailureRevision.current = targetRevision;
      setPruneError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (pruningRevision.current === targetRevision) pruningRevision.current = null;
    });
    return () => {
      active = false;
    };
  }, [pruneRetryNonce, profilesState, settings]);
  const retryProfilePruning = useCallback(async () => {
    pruneFailureRevision.current = null;
    setPruneError(null);
    await settings.reload();
    setPruneRetryNonce((current) => current + 1);
  }, [settings]);
  useEffect(() => {
    if (!values || !revision || syncedRevision.current === revision || queuedRevision.current === revision) return;
    const targetRevision = revision;
    const targetValues = values;
    queuedRevision.current = targetRevision;
    syncQueue.current = syncQueue.current.catch(() => undefined).then(async () => {
      if (syncedRevision.current === targetRevision) return;
      setSyncError(null);
      let lastError: unknown;
      for (const delayMs of SYNC_RETRY_DELAYS_MS) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          if (serverRevision.current === undefined) serverRevision.current = (await getRevision({})).revision;
          const result = await sync({ revision: targetRevision, previousRevision: serverRevision.current, values: targetValues });
          if (result.revision !== targetRevision) throw new Error("The Pi tool policy sync returned a different revision");
          syncedRevision.current = result.revision;
          serverRevision.current = result.revision;
          return;
        } catch (error) { lastError = error; }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }).catch((error: unknown) => { syncedRevision.current = null; setSyncError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (queuedRevision.current === targetRevision) queuedRevision.current = null; });
  }, [getRevision, revision, sync, values]);

  const styles = useMemo(() => ({ secondary: { color: theme.colors.foregroundMuted }, error: { color: theme.colors.statusDanger } }), [theme]);
  if (settings.status === "loading") return <Text style={styles.secondary}>Loading Pi tool policy…</Text>;
  if (settings.status !== "ready") return <SettingsSection title="Pi tool policy"><Text accessibilityRole="alert" style={styles.error}>{settings.error}</Text><SettingsAction label="Settings" actionLabel="Reload" onPress={settings.reload} />{settings.status === "invalid" ? <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={settings.reset} /> : null}</SettingsSection>;
  return <View><PolicyEditor settings={settings} theme={theme} profilesState={profilesState} knownToolsState={knownToolsState} onRetryProfiles={refreshProfiles} onRetryKnownTools={refreshKnownTools} />{pruneError ? <><Text accessibilityRole="alert" style={styles.error}>Could not synchronize saved Pi profile policies: {pruneError}</Text><SettingsAction label="Profile policy cleanup" actionLabel="Retry" onPress={() => void retryProfilePruning()} disabled={settings.saving} /></> : null}{syncError ? <Text accessibilityRole="alert" style={styles.error}>Could not sync policy with the Pi provider: {syncError}</Text> : null}</View>;
}

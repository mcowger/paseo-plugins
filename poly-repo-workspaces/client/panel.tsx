import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import {
  archiveVirtualWorkspace,
  getRepoStatuses,
  isMissingWorktreeError,
  type RepoStatus,
  regenerateRepomap,
  repairConstituent,
  type VirtualWorkspaceSummary,
} from "../shared/rpc";
import { setupLabel } from "../shared/setup-progress";
import { useArchiveJob } from "./use-archive-job";
import { useVirtualWorkspaces } from "./use-virtual-workspaces";

interface PanelStyles {
  readonly scroll: ViewStyle;
  readonly container: ViewStyle;
  readonly title: TextStyle;
  readonly sectionLabel: TextStyle;
  readonly header: ViewStyle;
  readonly footer: ViewStyle;
  readonly meta: TextStyle;
  readonly row: ViewStyle;
  readonly repoName: TextStyle;
  readonly repoDetail: TextStyle;
  readonly repoDirty: TextStyle;
  readonly repoError: TextStyle;
  readonly repoActions: ViewStyle;
  readonly miniButton: ViewStyle;
  readonly miniButtonText: TextStyle;
  readonly actions: ViewStyle;
  readonly button: ViewStyle;
  readonly buttonText: TextStyle;
  readonly buttonDanger: ViewStyle;
  readonly buttonDangerText: TextStyle;
  readonly empty: TextStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): PanelStyles {
  const fontSize = compact ? 14 : 15;
  const small = compact ? 13 : 14;
  return {
    scroll: { flex: 1 },
    container: {
      width: "100%",
      maxWidth: 800,
      alignSelf: "center",
      paddingHorizontal: compact ? 16 : 24,
      paddingTop: compact ? 16 : 24,
      paddingBottom: 32,
      gap: 16,
    },
    header: {
      gap: 8,
      padding: compact ? 16 : 20,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    footer: {
      gap: 12,
      padding: compact ? 16 : 20,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    sectionLabel: { color: theme.colors.foregroundMuted, fontSize: small, fontWeight: "600" },
    title: { color: theme.colors.foreground, fontSize: fontSize + 2, fontWeight: "700" },
    meta: { color: theme.colors.foregroundMuted, fontSize: small },
    row: {
      gap: 6,
      padding: compact ? 16 : 20,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    repoName: { color: theme.colors.foreground, fontSize, fontWeight: "600" },
    repoDetail: { color: theme.colors.foregroundMuted, fontSize: small },
    repoDirty: { color: theme.colors.statusWarning, fontSize: small },
    repoError: { color: theme.colors.statusDanger, fontSize: small },
    repoActions: { flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 4 },
    miniButton: {
      minHeight: 44,
      justifyContent: "center",
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    miniButtonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "500" },
    actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    buttonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
    buttonDanger: {
      minHeight: 44,
      justifyContent: "center",
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
    },
    buttonDangerText: {
      color: theme.colors.statusDanger,
      fontSize: small,
      fontWeight: "600",
    },
    empty: { color: theme.colors.foregroundMuted, fontSize: small },
  };
}

function describeStatus(status: RepoStatus): string {
  const parts = [`branch ${status.branch}`];
  if (status.dirty) parts.push(`${status.dirtyFileCount} changed`);
  if (status.ahead !== null && status.ahead > 0) parts.push(`${status.ahead} ahead`);
  if (status.behind !== null && status.behind > 0) parts.push(`${status.behind} behind`);
  if (!status.dirty && (status.ahead ?? 0) === 0) parts.push("clean");
  return parts.join(" · ");
}

export function PolyRepoPanel({
  theme,
  layout,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps): ReactElement {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const toast = useToast();
  const paseo = usePaseo();
  const { items, refresh } = useVirtualWorkspaces();
  const callStatuses = useRpc(getRepoStatuses);
  const waitForArchive = useArchiveJob();
  const callArchive = useRpc(archiveVirtualWorkspace);
  const callRepomap = useRpc(regenerateRepomap);
  const callRepair = useRpc(repairConstituent);
  const [statuses, setStatuses] = useState<readonly RepoStatus[]>([]);
  const [blocked, setBlocked] = useState<readonly RepoStatus[]>([]);
  const [busy, setBusy] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const match: VirtualWorkspaceSummary | null = useMemo(
    () => items.find((item) => item.workspaceId === workspaceId) ?? null,
    [items, workspaceId],
  );

  const loadStatuses = useCallback(async () => {
    if (!match) return;
    try {
      const result = await callStatuses({ virtualId: match.virtualId });
      if (result.ok) setStatuses(result.statuses);
    } catch {
      // Panel keeps the last known statuses; refresh surfaces errors.
    }
  }, [callStatuses, match]);

  useEffect(() => {
    setBlocked([]);
    void loadStatuses();
  }, [loadStatuses]);

  const handleArchive = useCallback(async () => {
    if (!match || busy) return;
    setBusy(true);
    try {
      const { jobId } = await callArchive({ virtualId: match.virtualId });
      const result = await waitForArchive(jobId);
      if (result.ok) {
        toast.show("Virtual workspace archived");
        refresh();
        return;
      }
      if (result.blocked.length > 0) {
        setBlocked(result.blocked);
        toast.error("Some repos are dirty or ahead; resolve them, then archive again");
        return;
      }
      toast.error(result.error ?? "Archive failed");
    } catch (unknownError) {
      if (mounted.current)
        toast.error(unknownError instanceof Error ? unknownError.message : "Archive failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, callArchive, match, refresh, toast, waitForArchive]);

  const handleForceArchive = useCallback(async () => {
    if (!match || busy || blocked.length === 0) return;
    setBusy(true);
    try {
      const { jobId } = await callArchive({
        virtualId: match.virtualId,
        forceRepoIds: blocked.map((status) => status.repoId),
      });
      const result = await waitForArchive(jobId);
      if (result.ok) {
        toast.show("Virtual workspace archived");
        refresh();
        return;
      }
      setBlocked(result.blocked);
      toast.error(result.error ?? "Archive failed");
    } catch (unknownError) {
      if (mounted.current)
        toast.error(unknownError instanceof Error ? unknownError.message : "Archive failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [blocked, busy, callArchive, match, refresh, toast, waitForArchive]);

  const handleRepomap = useCallback(async () => {
    if (!match || busy) return;
    setBusy(true);
    try {
      const result = await callRepomap({ virtualId: match.virtualId });
      if (result.ok) {
        toast.show("REPOMAP.md regenerated");
      } else {
        toast.error(result.error ?? "Regenerate failed");
      }
    } catch (unknownError) {
      toast.error(unknownError instanceof Error ? unknownError.message : "Regenerate failed");
    } finally {
      setBusy(false);
    }
  }, [busy, callRepomap, match, toast]);

  const handleRepair = useCallback(
    async (repoId: string) => {
      if (!match || busy) return;
      setBusy(true);
      try {
        const result = await callRepair({ virtualId: match.virtualId, repoId });
        if (result.ok) {
          toast.show(`${repoId} worktree restored`);
          await loadStatuses();
          refresh();
        } else {
          toast.error(result.error ?? "Repair failed");
        }
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Repair failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, callRepair, loadStatuses, match, refresh, toast],
  );

  const repairPressHandlers = useMemo(
    () =>
      new Map(
        (match?.constituents ?? []).map((constituent) => [
          constituent.repoId,
          () => {
            void handleRepair(constituent.repoId);
          },
        ]),
      ),
    [handleRepair, match],
  );

  const handleRefreshPress = useCallback(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const handleRepomapPress = useCallback(() => {
    void handleRepomap();
  }, [handleRepomap]);

  const handleArchivePress = useCallback(() => {
    void handleArchive();
  }, [handleArchive]);

  const handleForceArchivePress = useCallback(() => {
    void handleForceArchive();
  }, [handleForceArchive]);

  const openTerminal = useCallback(
    async (repoId: string, cwd: string) => {
      if (!match?.workspaceId || busy) return;
      setBusy(true);
      try {
        await paseo.workspaces.ref(match.workspaceId).terminals.create({ cwd, name: repoId });
        toast.show(`Terminal opened in ${repoId}`);
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Terminal failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, match, paseo, toast],
  );

  const openRepoWorkspace = useCallback(
    async (repoId: string, cwd: string, repoWorkspaceId: string | null) => {
      if (busy) return;
      setBusy(true);
      try {
        // Prefer the row the plugin already registered: it carries the virtual
        // root's project, so it opens inside the group instead of minting a
        // workspace in the repo's own project.
        const handle = repoWorkspaceId ? { id: repoWorkspaceId } : await paseo.workspaces.open(cwd);
        if (navigation) navigation.openWorkspace({ workspaceId: handle.id });
        else toast.show(`Opened ${repoId} as its own workspace`);
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Open failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, navigation, paseo, toast],
  );

  const copyRepoPath = useCallback(
    async (repoId: string, cwd: string) => {
      try {
        await copyText(cwd);
        toast.show(`${repoId} path copied`);
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Copy failed");
      }
    },
    [toast],
  );

  const terminalPressHandlers = useMemo(
    () =>
      new Map(
        (match?.constituents ?? []).map((constituent) => [
          constituent.repoId,
          () => {
            void openTerminal(constituent.repoId, constituent.worktreePath);
          },
        ]),
      ),
    [match, openTerminal],
  );

  const openPressHandlers = useMemo(
    () =>
      new Map(
        (match?.constituents ?? []).map((constituent) => [
          constituent.repoId,
          () => {
            void openRepoWorkspace(
              constituent.repoId,
              constituent.worktreePath,
              constituent.workspaceId,
            );
          },
        ]),
      ),
    [match, openRepoWorkspace],
  );

  const copyPressHandlers = useMemo(
    () =>
      new Map(
        (match?.constituents ?? []).map((constituent) => [
          constituent.repoId,
          () => {
            void copyRepoPath(constituent.repoId, constituent.worktreePath);
          },
        ]),
      ),
    [copyRepoPath, match],
  );

  if (!match) {
    return (
      <ScrollView
        nestedScrollEnabled
        style={styles.scroll}
        contentContainerStyle={styles.container}
      >
        <Text style={styles.empty}>This workspace is not a poly-repo virtual workspace.</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView nestedScrollEnabled style={styles.scroll} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {match.feature} · {match.branch}
        </Text>
        <Text style={styles.meta}>{match.rootPath}</Text>
      </View>
      <Text style={styles.sectionLabel}>REPOSITORIES</Text>
      {match.constituents.map((constituent) => {
        const status = statuses.find((entry) => entry.repoId === constituent.repoId);
        return (
          <View key={constituent.repoId} style={styles.row}>
            <Text style={styles.repoName}>{constituent.repoId}</Text>
            <Text style={styles.repoDetail}>{constituent.worktreePath}</Text>
            <Text
              style={setupLabel(constituent) === "failed" ? styles.repoError : styles.repoDetail}
            >
              Setup: {setupLabel(constituent)}
            </Text>
            {constituent.setupError ? (
              <Text style={styles.repoError}>{constituent.setupError}</Text>
            ) : null}
            {status ? (
              <Text style={status.dirty || status.error ? styles.repoDirty : styles.repoDetail}>
                {status.error ?? describeStatus(status)}
              </Text>
            ) : (
              <Text style={styles.repoDetail}>loading status...</Text>
            )}
            {status?.diffStat ? <Text style={styles.repoDetail}>{status.diffStat}</Text> : null}
            <View style={styles.repoActions}>
              {status && isMissingWorktreeError(status.error) ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Restore missing ${constituent.repoId} worktree`}
                  onPress={repairPressHandlers.get(constituent.repoId)}
                  style={styles.miniButton}
                  disabled={busy}
                >
                  <Text style={styles.miniButtonText}>Repair</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open terminal in ${constituent.repoId}`}
                onPress={terminalPressHandlers.get(constituent.repoId)}
                style={styles.miniButton}
                disabled={busy}
              >
                <Text style={styles.miniButtonText}>Terminal</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${constituent.repoId} as its own workspace`}
                onPress={openPressHandlers.get(constituent.repoId)}
                style={styles.miniButton}
                disabled={busy}
              >
                <Text style={styles.miniButtonText}>Open repo</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Copy ${constituent.repoId} path`}
                onPress={copyPressHandlers.get(constituent.repoId)}
                style={styles.miniButton}
              >
                <Text style={styles.miniButtonText}>Copy path</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      <View style={styles.footer}>
        <Text style={styles.sectionLabel}>WORKSPACE ACTIONS</Text>
        {blocked.length > 0 ? (
          <Text style={styles.repoDirty}>
            Blocked: {blocked.map((entry) => entry.repoId).join(", ")}. Commit or push first, or
            force-remove, which discards uncommitted work. Branches are kept either way.
          </Text>
        ) : null}
        {busy ? (
          <View style={styles.actions} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" />
            <Text style={styles.meta}>Working; archive may take a while for large workspaces.</Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh repo statuses"
            onPress={handleRefreshPress}
            style={styles.button}
            disabled={busy}
          >
            <Text style={styles.buttonText}>Refresh</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Regenerate REPOMAP.md"
            onPress={handleRepomapPress}
            style={styles.button}
            disabled={busy}
          >
            <Text style={styles.buttonText}>Regenerate REPOMAP</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Archive virtual workspace"
            onPress={handleArchivePress}
            style={styles.buttonDanger}
            disabled={busy}
          >
            <Text style={styles.buttonDangerText}>Archive</Text>
          </Pressable>
          {blocked.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Force archive. Discards uncommitted work; branches are kept."
              onPress={handleForceArchivePress}
              style={styles.buttonDanger}
              disabled={busy}
            >
              <Text style={styles.buttonDangerText}>Discard work & force archive</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

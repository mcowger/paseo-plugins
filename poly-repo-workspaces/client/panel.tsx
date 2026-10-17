import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, type TextStyle, View, type ViewStyle } from "react-native";
import {
  archiveVirtualWorkspace,
  getRepoStatuses,
  type RepoStatus,
  regenerateRepomap,
  type VirtualWorkspaceSummary,
} from "../shared/rpc";
import { useVirtualWorkspaces } from "./use-virtual-workspaces";

interface PanelStyles {
  readonly container: ViewStyle;
  readonly title: TextStyle;
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
  const fontSize = compact ? 12 : 13;
  const small = compact ? 10 : 11;
  return {
    container: { gap: 8 },
    title: { color: theme.colors.foreground, fontSize: fontSize + 2, fontWeight: "700" },
    meta: { color: theme.colors.foregroundMuted, fontSize: small },
    row: {
      gap: 2,
      paddingVertical: 6,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    repoName: { color: theme.colors.foreground, fontSize, fontWeight: "600" },
    repoDetail: { color: theme.colors.foregroundMuted, fontSize: small },
    repoDirty: { color: theme.colors.statusWarning, fontSize: small },
    repoError: { color: theme.colors.statusDanger, fontSize: small },
    repoActions: { flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 4 },
    miniButton: {
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    miniButtonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "500" },
    actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    button: {
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    buttonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
    buttonDanger: {
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
  const callArchive = useRpc(archiveVirtualWorkspace);
  const callRepomap = useRpc(regenerateRepomap);
  const [statuses, setStatuses] = useState<readonly RepoStatus[]>([]);
  const [blocked, setBlocked] = useState<readonly RepoStatus[]>([]);
  const [busy, setBusy] = useState(false);

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
      const result = await callArchive({ virtualId: match.virtualId });
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
      toast.error(unknownError instanceof Error ? unknownError.message : "Archive failed");
    } finally {
      setBusy(false);
    }
  }, [busy, callArchive, match, refresh, toast]);

  const handleForceArchive = useCallback(async () => {
    if (!match || busy || blocked.length === 0) return;
    setBusy(true);
    try {
      const result = await callArchive({
        virtualId: match.virtualId,
        forceRepoIds: blocked.map((status) => status.repoId),
      });
      if (result.ok) {
        toast.show("Virtual workspace archived");
        refresh();
        return;
      }
      setBlocked(result.blocked);
      toast.error(result.error ?? "Archive failed");
    } catch (unknownError) {
      toast.error(unknownError instanceof Error ? unknownError.message : "Archive failed");
    } finally {
      setBusy(false);
    }
  }, [blocked, busy, callArchive, match, refresh, toast]);

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
    async (repoId: string, cwd: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const handle = await paseo.workspaces.open(cwd);
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
            void openRepoWorkspace(constituent.repoId, constituent.worktreePath);
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
      <View style={styles.container}>
        <Text style={styles.empty}>This workspace is not a poly-repo virtual workspace.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {match.feature} · {match.branch}
      </Text>
      <Text style={styles.meta}>{match.rootPath}</Text>
      {match.constituents.map((constituent) => {
        const status = statuses.find((entry) => entry.repoId === constituent.repoId);
        return (
          <View key={constituent.repoId} style={styles.row}>
            <Text style={styles.repoName}>{constituent.repoId}</Text>
            <Text style={styles.repoDetail}>{constituent.worktreePath}</Text>
            {status ? (
              <Text style={status.dirty || status.error ? styles.repoDirty : styles.repoDetail}>
                {status.error ?? describeStatus(status)}
              </Text>
            ) : (
              <Text style={styles.repoDetail}>loading status...</Text>
            )}
            {status?.error ? <Text style={styles.repoError}>{status.error}</Text> : null}
            {status?.diffStat ? <Text style={styles.repoDetail}>{status.diffStat}</Text> : null}
            <View style={styles.repoActions}>
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
      {blocked.length > 0 ? (
        <Text style={styles.repoDirty}>
          Blocked: {blocked.map((entry) => entry.repoId).join(", ")}. Commit or push first, or
          force-remove, which discards uncommitted work. Branches are kept either way.
        </Text>
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
  );
}

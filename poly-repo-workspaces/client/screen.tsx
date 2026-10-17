import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, type TextStyle, View, type ViewStyle } from "react-native";
import type { UberProject } from "../shared/config";
import {
  archiveVirtualWorkspace,
  cleanupVirtualWorkspace,
  createVirtualWorkspace,
  forgetVirtualWorkspace,
  listUberProjects,
  type PreflightIssue,
  reconcileVirtualWorkspaces,
  type VirtualWorkspaceSummary,
} from "../shared/rpc";
import { useVirtualWorkspaces } from "./use-virtual-workspaces";

interface ScreenStyles {
  readonly container: ViewStyle;
  readonly heading: TextStyle;
  readonly label: TextStyle;
  readonly input: TextStyle;
  readonly row: ViewStyle;
  readonly name: TextStyle;
  readonly meta: TextStyle;
  readonly state: TextStyle;
  readonly stateBad: TextStyle;
  readonly issue: TextStyle;
  readonly actions: ViewStyle;
  readonly button: ViewStyle;
  readonly buttonText: TextStyle;
  readonly buttonDisabled: ViewStyle;
  readonly empty: TextStyle;
  readonly section: ViewStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): ScreenStyles {
  const fontSize = compact ? 12 : 13;
  const small = compact ? 10 : 11;
  return {
    container: { gap: 10 },
    heading: { color: theme.colors.foreground, fontSize: fontSize + 3, fontWeight: "700" },
    label: { color: theme.colors.foregroundMuted, fontSize: small, fontWeight: "600" },
    input: {
      color: theme.colors.foreground,
      fontSize,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    row: { gap: 2, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.border },
    name: { color: theme.colors.foreground, fontSize, fontWeight: "600" },
    meta: { color: theme.colors.foregroundMuted, fontSize: small },
    state: { color: theme.colors.statusSuccess, fontSize: small },
    stateBad: { color: theme.colors.statusWarning, fontSize: small },
    issue: { color: theme.colors.statusDanger, fontSize: small },
    actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    button: {
      paddingVertical: 7,
      paddingHorizontal: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    buttonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
    buttonDisabled: { opacity: 0.5 },
    empty: { color: theme.colors.foregroundMuted, fontSize: small },
    section: { gap: 6 },
  };
}

function stateLabel(item: VirtualWorkspaceSummary): string {
  if (item.state === "ready") {
    const dirty = item.dirtyRepos > 0 ? ` · ${item.dirtyRepos} dirty` : "";
    const ahead = item.aheadRepos > 0 ? ` · ${item.aheadRepos} ahead` : "";
    const detached = item.workspaceId ? "" : " · workspace closed";
    return `${item.constituents.length} repos · ready${dirty}${ahead}${detached}`;
  }
  if (item.state === "teardown-blocked") return "teardown blocked · clean up the root, then retry";
  if (item.state === "orphaned") {
    return item.rootExists ? "orphaned · root has no manifest" : "orphaned · root is gone";
  }
  return item.state;
}

export function PolyRepoScreen({
  theme,
  layout,
  navigation,
  params,
}: PluginScreenProps): ReactElement {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const toast = useToast();
  const { items, loading, error, refresh } = useVirtualWorkspaces();
  const callProjects = useRpc(listUberProjects);
  const callCreate = useRpc(createVirtualWorkspace);
  const callArchive = useRpc(archiveVirtualWorkspace);
  const callReconcile = useRpc(reconcileVirtualWorkspaces);
  const callForget = useRpc(forgetVirtualWorkspace);
  const callCleanup = useRpc(cleanupVirtualWorkspace);

  const paseo = usePaseo();
  const [projects, setProjects] = useState<readonly UberProject[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [feature, setFeature] = useState("");
  const [withTerminals, setWithTerminals] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<readonly PreflightIssue[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await callProjects({});
        if (cancelled) return;
        setProjects(result.uberProjects);
        const firstId = result.uberProjects[0]?.id;
        if (result.uberProjects.length > 0 && firstId) {
          setSelectedProject((prev) => prev || firstId);
        }
      } catch {
        if (!cancelled) setProjects([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [callProjects]);

  const focused = useMemo(
    () => items.find((item) => item.virtualId === params.virtualId) ?? null,
    [items, params],
  );

  const handleCreate = useCallback(async () => {
    if (busy || !selectedProject || feature.trim().length === 0) return;
    setBusy(true);
    setIssues([]);
    setCreateError(null);
    try {
      const result = await callCreate({
        uberProjectId: selectedProject,
        feature: feature.trim(),
        createTerminals: withTerminals || undefined,
      });
      if (result.ok) {
        toast.show(`Created ${feature.trim()}`);
        setFeature("");
        refresh();
        return;
      }
      if (result.preflight.length > 0) {
        setIssues(result.preflight);
        toast.error("Preflight found problems; fix them and retry");
        return;
      }
      setCreateError(result.error ?? "Create failed");
    } catch (unknownError) {
      setCreateError(unknownError instanceof Error ? unknownError.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }, [busy, callCreate, feature, refresh, selectedProject, toast, withTerminals]);

  const handleCreatePress = useCallback(() => {
    void handleCreate();
  }, [handleCreate]);

  const toggleTerminals = useCallback(() => {
    setWithTerminals((prev) => !prev);
  }, []);

  const terminalsAccessibilityState = useMemo(() => ({ checked: withTerminals }), [withTerminals]);

  const doResume = useCallback(
    async (uberProjectId: string, itemFeature: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await callCreate({ uberProjectId, feature: itemFeature, resume: true });
        if (result.ok) {
          toast.show(`Resumed ${itemFeature}`);
          refresh();
        } else if (result.preflight.length > 0) {
          toast.error("Preflight still failing; resolve and retry");
        } else {
          toast.error(result.error ?? "Resume failed");
        }
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Resume failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, callCreate, refresh, toast],
  );

  const doReopen = useCallback(
    async (rootPath: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const handle = await paseo.workspaces.open(rootPath);
        if (navigation) navigation.openWorkspace({ workspaceId: handle.id });
        else toast.show("Workspace reopened");
        refresh();
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Reopen failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, navigation, paseo, refresh, toast],
  );

  const doResync = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await callReconcile({});
      if (!result.ok) {
        toast.error(result.error ?? "Resync failed");
        return;
      }
      const { report } = result;
      const parts: string[] = [];
      if (report.adopted.length > 0) parts.push(`adopted ${report.adopted.length}`);
      if (report.finishedTeardown.length > 0)
        parts.push(`finished ${report.finishedTeardown.length}`);
      if (report.relinked.length > 0) parts.push(`relinked ${report.relinked.length}`);
      if (report.workspaceCleared.length > 0)
        parts.push(`detached ${report.workspaceCleared.length}`);
      if (report.orphaned.length > 0) parts.push(`${report.orphaned.length} orphaned`);
      if (report.invalid.length > 0) parts.push(`${report.invalid.length} invalid`);
      toast.show(parts.length > 0 ? `Resync: ${parts.join(", ")}` : "Resync: nothing to fix");
      refresh();
    } catch (unknownError) {
      toast.error(unknownError instanceof Error ? unknownError.message : "Resync failed");
    } finally {
      setBusy(false);
    }
  }, [busy, callReconcile, refresh, toast]);

  const doForget = useCallback(
    async (virtualId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await callForget({ virtualId });
        if (result.ok) {
          toast.show("Forgotten");
          refresh();
        } else {
          toast.error(result.error ?? "Forget failed");
        }
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Forget failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, callForget, refresh, toast],
  );

  const doCleanup = useCallback(
    async (virtualId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await callCleanup({ virtualId });
        if (result.ok) {
          toast.show("Cleaned up");
          refresh();
        } else {
          toast.error(result.error ?? "Clean up failed");
        }
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Clean up failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, callCleanup, refresh, toast],
  );

  const resumePressHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            void doResume(item.uberProjectId, item.feature);
          },
        ]),
      ),
    [doResume, items],
  );

  const reopenPressHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            void doReopen(item.rootPath);
          },
        ]),
      ),
    [doReopen, items],
  );

  const handleResyncPress = useCallback(() => {
    void doResync();
  }, [doResync]);

  const forgetPressHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            void doForget(item.virtualId);
          },
        ]),
      ),
    [doForget, items],
  );

  const cleanupPressHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            void doCleanup(item.virtualId);
          },
        ]),
      ),
    [doCleanup, items],
  );

  const doArchive = useCallback(
    async (virtualId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await callArchive({ virtualId });
        if (result.ok) {
          toast.show("Virtual workspace archived");
          refresh();
        } else if (result.blocked.length > 0) {
          toast.error("Repos are dirty or ahead; open the workspace panel to resolve");
        } else {
          toast.error(result.error ?? "Archive failed");
        }
      } catch (unknownError) {
        toast.error(unknownError instanceof Error ? unknownError.message : "Archive failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, callArchive, refresh, toast],
  );

  const archiveHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            void doArchive(item.virtualId);
          },
        ]),
      ),
    [doArchive, items],
  );

  const openHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            if (item.workspaceId && navigation) {
              navigation.openWorkspace({ workspaceId: item.workspaceId });
            }
          },
        ]),
      ),
    [items, navigation],
  );

  const selectHandlers = useMemo(
    () => new Map(projects.map((project) => [project.id, () => setSelectedProject(project.id)])),
    [projects],
  );

  const projectButtons = useMemo(
    () =>
      projects.map((project) => (
        <Pressable
          key={project.id}
          accessibilityRole="button"
          accessibilityLabel={`Use ${project.displayName}`}
          onPress={selectHandlers.get(project.id)}
          style={[styles.button, project.id === selectedProject ? null : styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{project.displayName}</Text>
        </Pressable>
      )),
    [projects, selectHandlers, selectedProject, styles],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Poly-repo workspaces</Text>

      <View style={styles.section}>
        <Text style={styles.label}>NEW VIRTUAL WORKSPACE</Text>
        {projects.length === 0 ? (
          <Text style={styles.empty}>No uber-projects yet. Add one in Settings → Poly-repo.</Text>
        ) : (
          <>
            <View style={styles.actions}>{projectButtons}</View>
            <TextInput
              accessibilityLabel="Feature name"
              placeholder="featureA"
              value={feature}
              onChangeText={setFeature}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create virtual workspace"
                onPress={handleCreatePress}
                style={styles.button}
                disabled={busy}
              >
                <Text style={styles.buttonText}>Create</Text>
              </Pressable>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel="Open a terminal in each repo after creation"
                accessibilityState={terminalsAccessibilityState}
                onPress={toggleTerminals}
                style={styles.button}
              >
                <Text style={styles.buttonText}>
                  {withTerminals ? "Terminals: on" : "Terminals: off"}
                </Text>
              </Pressable>
            </View>
          </>
        )}
        {createError ? <Text style={styles.issue}>{createError}</Text> : null}
        {issues.map((issue) => (
          <Text key={`${issue.repoId}-${issue.code}`} style={styles.issue}>
            {issue.repoId}: {issue.message}
          </Text>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>MANAGED WORKSPACES</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resync with the filesystem and host"
            onPress={handleResyncPress}
            style={styles.button}
            disabled={busy}
          >
            <Text style={styles.buttonText}>Resync</Text>
          </Pressable>
        </View>
        {loading && items.length === 0 ? <Text style={styles.empty}>Loading...</Text> : null}
        {error ? <Text style={styles.issue}>{error}</Text> : null}
        {items.map((item) => (
          <View key={item.virtualId} style={styles.row}>
            <Text style={styles.name}>
              {item.feature} · {item.branch}
            </Text>
            <Text style={item.state === "ready" ? styles.state : styles.stateBad}>
              {stateLabel(item)}
              {focused?.virtualId === item.virtualId ? " · selected" : ""}
            </Text>
            <Text style={styles.meta}>{item.rootPath}</Text>
            <View style={styles.actions}>
              {item.workspaceId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.feature}`}
                  onPress={openHandlers.get(item.virtualId)}
                  style={styles.button}
                >
                  <Text style={styles.buttonText}>Open</Text>
                </Pressable>
              ) : null}
              {item.state === "creating" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Resume ${item.feature}`}
                  onPress={resumePressHandlers.get(item.virtualId)}
                  style={styles.button}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Resume</Text>
                </Pressable>
              ) : null}
              {item.state === "creating" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Discard partially created ${item.feature}`}
                  onPress={archiveHandlers.get(item.virtualId)}
                  style={styles.button}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Discard</Text>
                </Pressable>
              ) : null}
              {!item.workspaceId && item.rootExists ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Reopen ${item.feature} root as a workspace`}
                  onPress={reopenPressHandlers.get(item.virtualId)}
                  style={styles.button}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Reopen</Text>
                </Pressable>
              ) : null}
              {item.state === "orphaned" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Forget ${item.feature}`}
                  onPress={forgetPressHandlers.get(item.virtualId)}
                  style={styles.button}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Forget</Text>
                </Pressable>
              ) : null}
              {item.state === "orphaned" && item.rootExists ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.feature} root and forget`}
                  onPress={cleanupPressHandlers.get(item.virtualId)}
                  style={styles.button}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Clean up</Text>
                </Pressable>
              ) : null}
              {item.state === "creating" || item.state === "orphaned" ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Archive ${item.feature}`}
                  onPress={archiveHandlers.get(item.virtualId)}
                  style={styles.button}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Archive</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}
        {!loading && items.length === 0 ? (
          <Text style={styles.empty}>No virtual workspaces yet.</Text>
        ) : null}
      </View>
    </View>
  );
}

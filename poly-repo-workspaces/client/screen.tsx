import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import type { UberProject } from "../shared/config";
import { renderBranchName } from "../shared/names";
import {
  archiveVirtualWorkspace,
  cleanupVirtualWorkspace,
  createVirtualWorkspace,
  forgetVirtualWorkspace,
  getCreateJob,
  listImportBranches,
  listUberProjects,
  type PreflightIssue,
  reconcileVirtualWorkspaces,
  type VirtualWorkspaceSummary,
} from "../shared/rpc";
import { setupLabel } from "../shared/setup-progress";
import { PolyRepoSettingsScreen } from "./settings-screen";
import { useArchiveJob } from "./use-archive-job";
import { useVirtualWorkspaces } from "./use-virtual-workspaces";

interface ScreenStyles {
  readonly scroll: ViewStyle;
  readonly container: ViewStyle;
  readonly heading: TextStyle;
  readonly label: TextStyle;
  readonly input: TextStyle;
  readonly row: ViewStyle;
  readonly workspaceMain: ViewStyle;
  readonly workspaceIdentity: ViewStyle;
  readonly workspaceRepos: ViewStyle;
  readonly workspaceActions: ViewStyle;
  readonly workspacePathRow: ViewStyle;
  readonly workspacePath: TextStyle;
  readonly copyPathButton: ViewStyle;
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
  readonly progress: ViewStyle;
  readonly progressText: ViewStyle;
  readonly tabSelected: ViewStyle;
  readonly content: ViewStyle;
  readonly hidden: ViewStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): ScreenStyles {
  const fontSize = compact ? 14 : 15;
  const small = compact ? 13 : 14;
  return {
    scroll: { flex: 1 },
    container: {
      width: "100%",
      maxWidth: 1100,
      alignSelf: "center",
      paddingHorizontal: compact ? 16 : 24,
      paddingTop: compact ? 16 : 24,
      paddingBottom: 32,
      gap: 20,
    },
    heading: { color: theme.colors.foreground, fontSize: fontSize + 3, fontWeight: "700" },
    label: { color: theme.colors.foregroundMuted, fontSize: small, fontWeight: "600" },
    input: {
      color: theme.colors.foreground,
      fontSize,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      minHeight: 44,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    row: { gap: 8, paddingVertical: 14, borderTopWidth: 1, borderTopColor: theme.colors.border },
    workspaceMain: {
      flexDirection: compact ? "column" : "row",
      flexWrap: compact ? "nowrap" : "wrap",
      alignItems: compact ? "stretch" : "center",
      gap: 12,
    },
    workspaceIdentity: {
      flexGrow: 0,
      flexShrink: 1,
      flexBasis: compact ? "auto" : 150,
      minWidth: 0,
      gap: 4,
    },
    workspaceRepos: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      flexGrow: 2,
      flexShrink: 1,
      flexBasis: compact ? "auto" : 260,
      gap: 10,
    },
    workspaceActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
    workspacePathRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    workspacePath: { color: theme.colors.foregroundMuted, fontSize: small, flex: 1, minWidth: 0 },
    copyPathButton: {
      minHeight: 36,
      justifyContent: "center",
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    name: { color: theme.colors.foreground, fontSize, fontWeight: "600" },
    meta: { color: theme.colors.foregroundMuted, fontSize: small },
    state: { color: theme.colors.statusSuccess, fontSize: small },
    stateBad: { color: theme.colors.statusWarning, fontSize: small },
    issue: { color: theme.colors.statusDanger, fontSize: small },
    actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    button: {
      minHeight: 44,
      justifyContent: "center",
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    buttonText: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
    buttonDisabled: { opacity: 0.5 },
    empty: { color: theme.colors.foregroundMuted, fontSize: small },
    section: {
      gap: 12,
      padding: compact ? 16 : 20,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    progress: { flexDirection: "row", alignItems: "center", gap: 8 },
    tabSelected: { borderWidth: 1, borderColor: theme.colors.foreground },
    content: { gap: 20 },
    hidden: { display: "none" },
    progressText: { flex: 1, gap: 6 },
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
  const callCreateJob = useRpc(getCreateJob);
  const callArchive = useRpc(archiveVirtualWorkspace);
  const waitForArchive = useArchiveJob();
  const callReconcile = useRpc(reconcileVirtualWorkspaces);
  const callForget = useRpc(forgetVirtualWorkspace);
  const callCleanup = useRpc(cleanupVirtualWorkspace);

  const mounted = useRef(true);
  const createPoll = useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(
    null,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (createPoll.current) {
        clearTimeout(createPoll.current.timer);
        createPoll.current.resolve();
        createPoll.current = null;
      }
    };
  }, []);
  const paseo = usePaseo();
  const [projects, setProjects] = useState<readonly UberProject[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [feature, setFeature] = useState("");
  const callBranches = useRpc(listImportBranches);
  const [importBranches, setImportBranches] = useState<readonly string[]>([]);
  const [defaultBranches, setDefaultBranches] = useState<
    readonly { repoId: string; branch: string }[]
  >([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [importBranch, setImportBranch] = useState("");
  const [withTerminals, setWithTerminals] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmForceId, setConfirmForceId] = useState<string | null>(null);
  const [creation, setCreation] = useState<{
    uberProjectId: string;
    feature: string;
    resuming: boolean;
    defaults?: boolean;
  } | null>(null);
  const [issues, setIssues] = useState<readonly PreflightIssue[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [tab, setTab] = useState<"workspaces" | "configuration">("workspaces");
  const [archiving, setArchiving] = useState<string | null>(null);

  useEffect(() => {
    if (!creation) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [creation, refresh]);

  useEffect(() => {
    if (tab !== "workspaces") return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await callProjects({});
        if (cancelled) return;
        setProjects(result.uberProjects);
        const firstId = result.uberProjects[0]?.id;
        setSelectedProject((prev) =>
          result.uberProjects.some((project) => project.id === prev) ? prev : (firstId ?? ""),
        );
      } catch {
        if (!cancelled) setProjects([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [callProjects, tab]);

  useEffect(() => {
    let cancelled = false;
    setImportBranches([]);
    setDefaultBranches([]);
    setImportBranch("");
    setBranchesError(null);
    setDefaultError(null);
    if (!selectedProject || !projects.some((project) => project.id === selectedProject)) {
      setBranchesLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setBranchesLoading(true);
    void callBranches({ uberProjectId: selectedProject })
      .then(
        (result) => {
          if (cancelled) return;
          setImportBranches(result.branches);
          setBranchesError(result.error);
          setDefaultBranches(result.defaults);
          setDefaultError(result.defaultError);
        },
        (unknownError: unknown) => {
          if (!cancelled) {
            const message =
              unknownError instanceof Error ? unknownError.message : "Branch discovery failed";
            setBranchesError(message);
            setDefaultError(message);
          }
        },
      )
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callBranches, selectedProject, projects]);
  const focused = useMemo(
    () => items.find((item) => item.virtualId === params.virtualId) ?? null,
    [items, params],
  );

  const selectedProjectConfig = projects.find((item) => item.id === selectedProject);
  const selectedDefaultBranches = defaultBranches;
  const branchPreview =
    importBranch ||
    (selectedProjectConfig && feature.trim()
      ? renderBranchName(selectedProjectConfig.branchTemplate, {
          uberProjectId: selectedProjectConfig.id,
          feature: feature.trim(),
        })
      : null);
  const createDisabled = busy || !selectedProject || feature.trim().length === 0;
  const creationRepoCount = projects.find((item) => item.id === creation?.uberProjectId)?.repos
    .length;

  const waitForCreate = useCallback(
    async (jobId: string) => {
      while (true) {
        if (!mounted.current) throw new Error("Screen closed");
        let status: RpcOutput<typeof getCreateJob>;
        try {
          status = await callCreateJob({ jobId });
        } catch (unknownError) {
          const detail = unknownError instanceof Error ? `: ${unknownError.message}` : "";
          throw new Error(`Could not check creation status; the job may still be running${detail}`);
        }
        if (!mounted.current) throw new Error("Screen closed");
        if (status.state === "finished") return status.result;
        if (status.state === "missing")
          throw new Error(
            "Create job was not found; it may have expired. Refresh and resume the workspace.",
          );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            createPoll.current = null;
            resolve();
          }, 500);
          createPoll.current = { timer, resolve };
        });
      }
    },
    [callCreateJob],
  );

  const handleCreate = useCallback(
    async (useDefaults = false) => {
      const workspaceFeature = feature.trim() || (useDefaults ? "default" : "");
      if (busy || !selectedProject || !workspaceFeature) return;
      setBusy(true);
      setCreation({
        uberProjectId: selectedProject,
        feature: workspaceFeature,
        resuming: false,
        defaults: useDefaults,
      });
      setIssues([]);
      setCreateError(null);
      try {
        const { jobId } = await callCreate({
          uberProjectId: selectedProject,
          feature: workspaceFeature,
          importBranch: useDefaults ? undefined : importBranch || undefined,
          importDefaults: useDefaults || undefined,
          createTerminals: withTerminals || undefined,
        });
        const result = await waitForCreate(jobId);
        if (result.ok) {
          toast.show(
            `${useDefaults ? "Imported default branches" : importBranch ? "Imported" : "Created"} ${workspaceFeature}`,
          );
          setFeature("");
          setImportBranch("");
          return;
        }
        if (result.preflight.length > 0) {
          setIssues(result.preflight);
          if (result.error) setCreateError(result.error);
          toast.error("Preflight found problems; fix them and retry");
          return;
        }
        setCreateError(result.error ?? "Create failed");
      } catch (unknownError) {
        if (mounted.current)
          setCreateError(unknownError instanceof Error ? unknownError.message : "Create failed");
      } finally {
        if (mounted.current) {
          setCreation(null);
          setBusy(false);
          refresh();
        }
      }
    },
    [
      busy,
      callCreate,
      feature,
      importBranch,
      refresh,
      selectedProject,
      toast,
      waitForCreate,
      withTerminals,
    ],
  );

  const handleCreatePress = useCallback(() => {
    void handleCreate();
  }, [handleCreate]);

  const handleImportDefaultsPress = useCallback(() => {
    void handleCreate(true);
  }, [handleCreate]);

  const toggleTerminals = useCallback(() => {
    setWithTerminals((prev) => !prev);
  }, []);

  const terminalsAccessibilityState = useMemo(
    () => ({ checked: withTerminals, disabled: busy }),
    [busy, withTerminals],
  );

  const doResume = useCallback(
    async (uberProjectId: string, itemFeature: string) => {
      if (busy) return;
      setBusy(true);
      setCreation({ uberProjectId, feature: itemFeature, resuming: true });
      try {
        const { jobId } = await callCreate({ uberProjectId, feature: itemFeature, resume: true });
        const result = await waitForCreate(jobId);
        if (result.ok) {
          toast.show(`Resumed ${itemFeature}`);
        } else if (result.preflight.length > 0) {
          toast.error("Preflight still failing; resolve and retry");
        } else {
          toast.error(result.error ?? "Resume failed");
        }
      } catch (unknownError) {
        if (mounted.current)
          toast.error(unknownError instanceof Error ? unknownError.message : "Resume failed");
      } finally {
        if (mounted.current) {
          setCreation(null);
          setBusy(false);
          refresh();
        }
      }
    },
    [busy, callCreate, refresh, toast, waitForCreate],
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
      if (report.scheduledTeardown.length > 0)
        parts.push(`resuming ${report.scheduledTeardown.length} archives`);
      if (report.relinked.length > 0) parts.push(`relinked ${report.relinked.length}`);
      if (report.repoWorkspacesCreated.length > 0)
        parts.push(`registered ${report.repoWorkspacesCreated.length} repos`);
      if (report.repoWorkspacesCleared.length > 0)
        parts.push(`unregistered ${report.repoWorkspacesCleared.length} repos`);
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
    async (virtualId: string, force = false) => {
      if (busy) return;
      setBusy(true);
      setArchiving(virtualId);
      try {
        const { jobId } = await callArchive({ virtualId, force: force || undefined });
        const result = await waitForArchive(jobId);
        if (result.ok) {
          toast.show(
            force
              ? "Workspace removed. Check for remaining Paseo workspace rows."
              : "Virtual workspace archived",
          );
          if (force) setConfirmForceId(null);
          refresh();
        } else if (result.blocked.length > 0) {
          toast.error(
            force
              ? (result.error ?? result.blocked.map((repo) => repo.error ?? repo.repoId).join(", "))
              : "Repos are dirty or ahead; open the workspace panel to resolve",
          );
        } else {
          toast.error(result.error ?? (force ? "Force removal failed" : "Archive failed"));
        }
      } catch (unknownError) {
        if (mounted.current)
          toast.error(unknownError instanceof Error ? unknownError.message : "Archive failed");
      } finally {
        if (mounted.current) {
          setArchiving(null);
          setBusy(false);
        }
      }
    },
    [busy, callArchive, refresh, toast, waitForArchive],
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

  const forceHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            if (busy) return;
            setConfirmForceId(item.virtualId);
          },
        ]),
      ),
    [busy, items],
  );

  const confirmForceHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            void doArchive(item.virtualId, true);
          },
        ]),
      ),
    [doArchive, items],
  );

  const cancelForce = useCallback(() => setConfirmForceId(null), []);

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

  const copyPathHandlers = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.virtualId,
          () => {
            void copyText(item.rootPath).then(
              () => toast.show("Workspace path copied"),
              (copyError: unknown) =>
                toast.error(copyError instanceof Error ? copyError.message : "Copy failed"),
            );
          },
        ]),
      ),
    [items, toast],
  );

  const selectHandlers = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          () => {
            if (project.id === selectedProject) return;
            setImportBranches([]);
            setDefaultBranches([]);
            setBranchesLoading(true);
            setBranchesError(null);
            setDefaultError(null);
            setSelectedProject(project.id);
            setImportBranch("");
            setFeature("");
          },
        ]),
      ),
    [projects, selectedProject],
  );

  const projectButtons = useMemo(
    () =>
      projects.map((project) => (
        <Pressable
          key={project.id}
          accessibilityRole="button"
          accessibilityLabel={`Use ${project.displayName}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={selectHandlers.get(project.id)}
          style={[styles.button, project.id === selectedProject ? null : styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{project.displayName}</Text>
        </Pressable>
      )),
    [busy, projects, selectHandlers, selectedProject, styles],
  );

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>Poly-repo workspaces</Text>
      <View style={styles.actions} accessibilityRole="tablist">
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel="Workspaces"
          accessibilityState={{ selected: tab === "workspaces" }}
          onPress={() => setTab("workspaces")}
          style={[styles.button, tab === "workspaces" ? styles.tabSelected : null]}
        >
          <Text style={styles.buttonText}>Workspaces</Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel="Configuration"
          accessibilityState={{ selected: tab === "configuration" }}
          onPress={() => setTab("configuration")}
          style={[styles.button, tab === "configuration" ? styles.tabSelected : null]}
        >
          <Text style={styles.buttonText}>Configuration</Text>
        </Pressable>
      </View>

      <View style={[styles.content, tab !== "workspaces" ? styles.hidden : null]}>
        <View style={styles.section}>
          <Text style={styles.label}>NEW VIRTUAL WORKSPACE</Text>
          {projects.length === 0 ? (
            <Text style={styles.empty}>No uber-projects yet. Add one under Configuration.</Text>
          ) : (
            <>
              <View style={styles.actions}>{projectButtons}</View>
              <TextInput
                accessibilityLabel="Feature name"
                placeholder="featureA"
                value={feature}
                onChangeText={setFeature}
                editable={!busy}
                maxLength={128}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {branchPreview ? <Text style={styles.meta}>Branch: {branchPreview}</Text> : null}
              <Text style={styles.label}>IMPORT COMMON BRANCH</Text>
              {branchesLoading ? <Text style={styles.meta}>Loading import branches...</Text> : null}
              {branchesError ? <Text style={styles.issue}>{branchesError}</Text> : null}
              {!branchesLoading && !branchesError && importBranches.length === 0 ? (
                <Text style={styles.meta}>No common branches available to import.</Text>
              ) : null}
              {importBranches.length > 0 ? (
                <View style={styles.actions}>
                  {importBranches.map((branch) => (
                    <Pressable
                      key={branch}
                      accessibilityRole="button"
                      accessibilityLabel={`Import branch ${branch}`}
                      accessibilityState={{ disabled: busy, selected: importBranch === branch }}
                      disabled={busy}
                      onPress={() => {
                        setImportBranch(importBranch === branch ? "" : branch);
                        setFeature(branch.replaceAll("/", "-"));
                      }}
                      style={[
                        styles.button,
                        importBranch === branch ? null : styles.buttonDisabled,
                      ]}
                    >
                      <Text style={styles.buttonText}>{branch}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {importBranch ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Use feature branch instead"
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  onPress={() => setImportBranch("")}
                  style={styles.button}
                >
                  <Text style={styles.buttonText}>Clear import branch</Text>
                </Pressable>
              ) : null}
              <Text style={styles.label}>DEFAULT BRANCHES</Text>
              {defaultError ? <Text style={styles.issue}>{defaultError}</Text> : null}
              {!branchesLoading && !defaultError && selectedDefaultBranches.length === 0 ? (
                <Text style={styles.meta}>No repository defaults available.</Text>
              ) : null}
              {selectedDefaultBranches.map(({ repoId, branch }) => (
                <Text key={repoId} style={styles.meta}>
                  {repoId}: {branch}
                </Text>
              ))}
              <Text style={styles.meta}>
                If a default branch is already checked out elsewhere, its worktree uses a detached
                HEAD. Create a branch to keep commits reachable.
              </Text>
              <Text style={styles.meta}>
                Uses the feature name above, or "default" if left blank.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create workspace from default branches"
                accessibilityState={{
                  disabled:
                    busy ||
                    branchesLoading ||
                    selectedDefaultBranches.length === 0 ||
                    Boolean(defaultError),
                  busy: Boolean(creation?.defaults),
                }}
                disabled={
                  busy ||
                  branchesLoading ||
                  selectedDefaultBranches.length === 0 ||
                  Boolean(defaultError)
                }
                onPress={handleImportDefaultsPress}
                style={[
                  styles.button,
                  busy || branchesLoading || selectedDefaultBranches.length === 0 || defaultError
                    ? styles.buttonDisabled
                    : null,
                ]}
              >
                <Text style={styles.buttonText}>
                  {creation?.defaults
                    ? "Creating from defaults..."
                    : "Create from default branches"}
                </Text>
              </Pressable>
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Create virtual workspace"
                  accessibilityState={{
                    disabled: createDisabled,
                    busy: creation !== null && !creation.resuming,
                  }}
                  onPress={handleCreatePress}
                  style={[styles.button, createDisabled ? styles.buttonDisabled : null]}
                  disabled={createDisabled}
                >
                  <Text style={styles.buttonText}>
                    {creation && !creation.resuming && !creation.defaults
                      ? importBranch
                        ? "Importing..."
                        : "Creating..."
                      : importBranch
                        ? "Import"
                        : "Create"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel="Open a terminal in each repo after creation"
                  accessibilityState={terminalsAccessibilityState}
                  disabled={busy}
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
          {creation ? (
            <View style={styles.progress}>
              <ActivityIndicator
                size="small"
                color={theme.colors.foregroundMuted}
                accessibilityLabel="Workspace creation in progress"
                accessibilityRole="progressbar"
              />
              <View style={styles.progressText}>
                <Text style={styles.meta} accessibilityLiveRegion="polite">
                  {creation.resuming ? "Resuming" : "Creating"} {creation.feature}...
                </Text>
                <Text style={styles.meta}>
                  Setting up {creationRepoCount ?? "the"} repo worktrees. Large repos can take a
                  while.
                </Text>
              </View>
            </View>
          ) : null}
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
              <View style={styles.workspaceMain}>
                <View style={styles.workspaceIdentity}>
                  <Text style={styles.name}>
                    {item.feature}
                    {item.branch !== item.feature ? ` · ${item.branch}` : ""}
                  </Text>
                  <Text style={item.state === "ready" ? styles.state : styles.stateBad}>
                    {stateLabel(item)}
                    {focused?.virtualId === item.virtualId ? " · selected" : ""}
                  </Text>
                </View>
                <View style={styles.workspaceRepos}>
                  {item.constituents.map((constituent) => {
                    const status = setupLabel(constituent);
                    return (
                      <Text
                        key={constituent.repoId}
                        style={status === "failed" ? styles.issue : styles.meta}
                        accessibilityLabel={`${constituent.repoId}: ${status}${constituent.setupError ? ` · ${constituent.setupError}` : ""}`}
                      >
                        {constituent.repoId}:{" "}
                        <Text style={status === "ready" ? styles.state : undefined}>
                          {status === "ready" ? "✓" : status}
                        </Text>
                        {constituent.setupError ? ` · ${constituent.setupError}` : ""}
                      </Text>
                    );
                  })}
                </View>
                <View style={styles.workspaceActions}>
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
                  {item.state !== "orphaned" ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Force delete ${item.feature}`}
                      onPress={forceHandlers.get(item.virtualId)}
                      style={styles.button}
                      disabled={busy}
                    >
                      <Text style={styles.buttonText}>Force delete</Text>
                    </Pressable>
                  ) : null}
                  {archiving === item.virtualId ? (
                    <View style={styles.progress}>
                      <ActivityIndicator
                        size="small"
                        color={theme.colors.foregroundMuted}
                        accessibilityLabel={`Archiving ${item.feature}`}
                        accessibilityRole="progressbar"
                      />
                      <Text style={styles.meta} accessibilityLiveRegion="polite">
                        Archiving {item.feature}; removing worktrees...
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <View style={styles.workspacePathRow}>
                <Text selectable style={styles.workspacePath}>
                  {item.rootPath}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Copy ${item.feature} workspace path`}
                  onPress={copyPathHandlers.get(item.virtualId)}
                  style={styles.copyPathButton}
                  hitSlop={4}
                >
                  <Text style={styles.buttonText}>Copy</Text>
                </Pressable>
              </View>
              {confirmForceId === item.virtualId ? (
                <View style={styles.section}>
                  <Text style={styles.issue}>
                    Force delete removes all worktrees, including uncommitted changes. Unpushed
                    commits may become harder to find. Branches are kept. If Paseo cannot archive a
                    workspace, its sidebar row may remain.
                  </Text>
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Confirm force delete ${item.feature}`}
                      onPress={confirmForceHandlers.get(item.virtualId)}
                      style={styles.button}
                      disabled={busy}
                    >
                      <Text style={styles.buttonText}>Confirm force delete</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Cancel force delete ${item.feature}`}
                      onPress={cancelForce}
                      style={styles.button}
                      disabled={busy}
                    >
                      <Text style={styles.buttonText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          ))}
          {!loading && items.length === 0 ? (
            <Text style={styles.empty}>No virtual workspaces yet.</Text>
          ) : null}
        </View>
      </View>
      <View style={tab !== "configuration" ? styles.hidden : undefined}>
        <PolyRepoSettingsScreen theme={theme} layout={layout} />
      </View>
    </ScrollView>
  );
}

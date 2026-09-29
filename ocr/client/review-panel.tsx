import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import {
  usePaseo,
  useRpc,
  useSettings,
  useWorkspace,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import {
  cancelReviewRpc,
  capabilitiesRpc,
  getReviewRpc,
  listHistoryRpc,
  listRefsRpc,
  loadSessionRpc,
  prepareSelectionRpc,
  startReviewRpc,
} from "../shared/contracts.js";
import type {
  Finding,
  ReviewMode,
  ReviewResult,
  ReviewStatus,
  SessionSummary,
} from "../shared/contracts.js";
import {
  DEFAULT_NEW_AGENT_INSTRUCTIONS,
  mergeBatches,
  preferencesSettings,
  selectionsSettings,
} from "../shared/settings.js";
import type { SelectionBatch } from "../shared/settings.js";
import {
  SEVERITY_LABELS,
  applySeverityPreset,
  buildAgentPrompt,
  sortFindings,
  summarizeSeverities,
  type SeverityPreset,
} from "../shared/presentation.js";

interface Capabilities {
  gitAvailable: boolean;
  isGitRepo: boolean;
  gitRoot: string | null;
  ocrAvailable: boolean;
  ocrVersion?: string;
  workspaceDirectory: string | null;
}

interface RefsState {
  gitRoot: string;
  currentBranch: string | null;
  branches: Array<{ name: string; isRemote: boolean; isCurrent: boolean }>;
  defaultTarget: string | null;
  defaultBase: string | null;
}

interface DisplayedReview {
  sessionId: string | null;
  mode: string;
  baseRef?: string;
  targetRef?: string;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; batchId: string; label: string }
  | { status: "error"; message: string };

const PRESETS: ReadonlyArray<{ id: SeverityPreset; label: string }> = [
  { id: "critical", label: "Critical" },
  { id: "high-plus", label: "High+" },
  { id: "medium-plus", label: "Medium+" },
  { id: "all", label: "All" },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStatus(status: ReviewStatus, findingCount: number): string {
  if (status === "running") return "Running";
  if (status === "canceled") return "Canceled (incomplete)";
  if (status === "error") return "Failed";
  if (status === "skipped") return "Skipped (no eligible files)";
  if (status === "unknown") return "Coverage unknown";
  if (status === "partial")
    return findingCount > 0 ? "Partial coverage, with findings" : "Partial coverage, no findings";
  return findingCount > 0 ? "Complete, with findings" : "Complete, no findings";
}

function collectAvailableModels(snapshot: PaseoProviderSnapshotResult): string[] {
  const seen = new Set<string>();
  for (const entry of snapshot.entries) {
    if (entry.status !== "ready") continue;
    if (entry.enabled === false) continue;
    for (const model of entry.models ?? []) {
      if (model.isSelectable === false) continue;
      seen.add(`${entry.provider}/${model.id}`);
    }
  }
  return [...seen].sort();
}

function FindingRow({
  finding,
  checked,
  onToggle,
  theme,
  compact,
}: {
  finding: Finding;
  checked: boolean;
  onToggle(): void;
  theme: PluginWorkspacePanelProps["theme"];
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const styles = useMemo(
    () => ({
      row: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: compact ? 8 : 12,
        gap: 4,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.foreground, fontSize: compact ? 13 : 14, flex: 1 },
      detail: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 },
      code: { color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 },
      toggle: { color: theme.colors.accent, fontSize: compact ? 12 : 13 },
      findingHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      checkbox: {
        width: 22,
        height: 22,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 5,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface0,
      },
      checkboxChecked: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
      checkMark: {
        color: theme.colors.accentForeground,
        fontSize: 14,
        lineHeight: 16,
      },
    }),
    [theme, compact],
  );
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={`Select finding ${finding.path} lines ${finding.startLine} to ${finding.endLine}`}
        onPress={onToggle}
        style={styles.findingHeader}
      >
        <View style={[styles.checkbox, checked ? styles.checkboxChecked : null]}>
          {checked ? <Text style={styles.checkMark}>{"\u2713"}</Text> : null}
        </View>
        <Text style={styles.title}>
          [{SEVERITY_LABELS[finding.severity]}] {finding.path}:{finding.startLine}-
          {finding.endLine}
        </Text>
      </Pressable>
      {finding.category ? <Text style={styles.detail}>Category: {finding.category}</Text> : null}
      <Text style={styles.detail}>{finding.content}</Text>
      {expanded ? (
        <View>
          {finding.existingCode ? (
            <Text style={styles.code}>Existing:{`\n${finding.existingCode}`}</Text>
          ) : null}
          {finding.suggestionCode ? (
            <Text style={styles.code}>Suggested:{`\n${finding.suggestionCode}`}</Text>
          ) : null}
          {!finding.existingCode && !finding.suggestionCode ? (
            <Text style={styles.detail}>No code snippet attached.</Text>
          ) : null}
        </View>
      ) : null}
      {finding.existingCode || finding.suggestionCode ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Hide code suggestion" : "Show code suggestion"}
          onPress={toggleExpanded}
        >
          <Text style={styles.toggle}>{expanded ? "Hide code" : "Show code"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ReviewPanel({
  workspaceId,
  theme,
  layout,
  navigation,
}: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ name, directory }) => ({ name, directory }));
  const paseo = usePaseo();
  const getCapabilities = useRpc(capabilitiesRpc);
  const listRefs = useRpc(listRefsRpc);
  const startReview = useRpc(startReviewRpc);
  const getReview = useRpc(getReviewRpc);
  const cancelReview = useRpc(cancelReviewRpc);
  const listHistory = useRpc(listHistoryRpc);
  const loadSession = useRpc(loadSessionRpc);
  const prepareSelection = useRpc(prepareSelectionRpc);
  const selections = useSettings(selectionsSettings);
  const preferences = useSettings(preferencesSettings);

  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capsLoading, setCapsLoading] = useState(true);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefsState | null>(null);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [scopeMode, setScopeMode] = useState<ReviewMode>("uncommitted");
  const [target, setTarget] = useState("");
  const [base, setBase] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sessionLoadingId, setSessionLoadingId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [displayed, setDisplayed] = useState<DisplayedReview | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null);
  const [chosenModel, setChosenModel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [defaultSaveError, setDefaultSaveError] = useState<string | null>(null);

  const selectionsRef = useRef(selections);
  useEffect(() => {
    selectionsRef.current = selections;
  }, [selections]);
  const preferencesRef = useRef(preferences);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 12 : 20,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      heading: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22 },
      subheading: { color: theme.colors.foreground, fontSize: layout.compact ? 14 : 16 },
      detail: { color: theme.colors.foregroundMuted, fontSize: layout.compact ? 12 : 13 },
      error: { color: theme.colors.statusDanger, fontSize: layout.compact ? 12 : 13 },
      warning: { color: theme.colors.statusWarning, fontSize: layout.compact ? 12 : 13 },
      success: { color: theme.colors.statusSuccess, fontSize: layout.compact ? 12 : 13 },
      button: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonDisabled: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
      buttonTextDisabled: { color: theme.colors.foregroundMuted, textAlign: "center" as const },
      row: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      chip: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      chipActive: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foreground, fontSize: layout.compact ? 12 : 13 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
      },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: layout.compact ? 8 : 12,
        gap: 6,
        backgroundColor: theme.colors.surface1,
      },
    }),
    [theme, layout.compact],
  );

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await listHistory({ workspaceId, limit: 20 });
      setHistory(result.sessions);
    } catch (error) {
      setHistoryError(messageOf(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [listHistory, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setCapsLoading(true);
      setCapsError(null);
      try {
        const caps = await getCapabilities({ workspaceId });
        if (cancelled) return;
        setCapabilities(caps);
        if (caps.isGitRepo) {
          try {
            const result = await listRefs({ workspaceId });
            if (cancelled) return;
            setRefs(result);
            setTarget(result.defaultTarget ?? "");
            setBase(result.defaultBase ?? "");
          } catch (error) {
            if (!cancelled) setRefsError(messageOf(error));
          }
        }
      } catch (error) {
        if (!cancelled) setCapsError(messageOf(error));
      } finally {
        if (!cancelled) setCapsLoading(false);
      }
    })();
    void refreshHistory();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, getCapabilities, listRefs, refreshHistory]);

  const applyJobFindings = useCallback((result: ReviewResult) => {
    setFindings(sortFindings(result.findings));
    setDisplayed({
      sessionId: result.sessionId ?? null,
      mode: result.mode,
      baseRef: result.baseRef,
      targetRef: result.targetRef,
    });
    setChecked(new Set());
    setSaveState({ status: "idle" });
  }, []);

  const isJobRunning = review?.status === "running";
  useEffect(() => {
    if (!jobId || !isJobRunning) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const result = await getReview({ workspaceId, jobId });
          if (cancelled) return;
          setReview(result.review);
          if (result.review.status !== "running") {
            applyJobFindings(result.review);
            void refreshHistory();
          }
        } catch (error) {
          if (!cancelled) setReviewError(messageOf(error));
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, isJobRunning, getReview, workspaceId, applyJobFindings, refreshHistory]);

  const handleStart = useCallback(async () => {
    setStartError(null);
    setReviewError(null);
    if (scopeMode === "branch") {
      if (!target || !base) {
        setStartError("Choose both a Target and a Base branch ref before running.");
        return;
      }
      if (target === base) {
        setStartError("Target and Base resolve to the same ref; pick two different refs.");
        return;
      }
      if (target.startsWith("-") || base.startsWith("-")) {
        setStartError("Branch refs must not start with a dash.");
        return;
      }
    }
    setStarting(true);
    try {
      const started = await startReview({
        workspaceId,
        mode: scopeMode,
        ...(scopeMode === "branch" ? { targetRef: target, baseRef: base } : {}),
      });
      setJobId(started.jobId);
      const result = await getReview({ workspaceId, jobId: started.jobId });
      setReview(result.review);
      if (result.review.status !== "running") {
        applyJobFindings(result.review);
        void refreshHistory();
      }
    } catch (error) {
      setStartError(messageOf(error));
    } finally {
      setStarting(false);
    }
  }, [scopeMode, target, base, startReview, workspaceId, getReview, applyJobFindings, refreshHistory]);

  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      await cancelReview({ workspaceId, jobId });
      const result = await getReview({ workspaceId, jobId });
      setReview(result.review);
      applyJobFindings(result.review);
    } catch (error) {
      setReviewError(messageOf(error));
    } finally {
      setCancelling(false);
    }
  }, [jobId, cancelReview, workspaceId, getReview, applyJobFindings]);

  const handleLoadSession = useCallback(
    async (session: SessionSummary) => {
      setSessionLoadingId(session.sessionId);
      setSessionError(null);
      try {
        const loaded = await loadSession({ workspaceId, sessionId: session.sessionId });
        setFindings(sortFindings(loaded.findings));
        setDisplayed({
          sessionId: loaded.sessionId,
          mode: loaded.reviewMode,
          baseRef: loaded.summary.diffFrom,
          targetRef: loaded.summary.diffTo,
        });
        setChecked(new Set());
        setSaveState({ status: "idle" });
        setJobId(null);
        setReview(null);
      } catch (error) {
        setSessionError(messageOf(error));
      } finally {
        setSessionLoadingId(null);
      }
    },
    [loadSession, workspaceId],
  );

  const applyPreset = useCallback(
    (preset: SeverityPreset) => {
      setChecked(new Set(applySeverityPreset(findings, preset)));
    },
    [findings],
  );

  const clearSelection = useCallback(() => {
    setChecked(new Set());
  }, []);

  const toggleFinding = useCallback((id: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedFindings = useMemo(
    () => findings.filter((finding) => checked.has(finding.id)),
    [findings, checked],
  );
  const severitySummary = useMemo(() => summarizeSeverities(selectedFindings), [selectedFindings]);

  const persistBatches = useCallback(
    async (batches: SelectionBatch[]): Promise<{ ok: boolean; error?: string }> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = selectionsRef.current;
        if (current.status !== "ready") {
          return { ok: false, error: "Selection storage is not ready yet; try again shortly." };
        }
        const saved = await current.save({ batches }, current.revision);
        if (saved) return { ok: true };
        if (attempt < 2) {
          await current.reload();
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else {
          const latest = selectionsRef.current;
          return {
            ok: false,
            error:
              latest.status === "ready" && latest.saveError
                ? latest.saveError
                : "Could not save the selection after a revision conflict; reload and retry.",
          };
        }
      }
      return { ok: false, error: "Could not save the selection." };
    },
    [],
  );

  const handleSaveSelection = useCallback(async () => {
    if (!displayed?.sessionId || selectedFindings.length === 0) return;
    setSaveState({ status: "saving" });
    try {
      const prepared = await prepareSelection({
        workspaceId,
        sessionId: displayed.sessionId,
        findingIds: selectedFindings.map((finding) => finding.id),
      });
      const current = selectionsRef.current;
      if (current.status !== "ready") {
        setSaveState({ status: "error", message: "Selection storage is not ready yet." });
        return;
      }
      const merged = mergeBatches(current.values.batches, prepared.batch);
      const result = await persistBatches(merged);
      if (result.ok) {
        setSaveState({ status: "saved", batchId: prepared.batch.id, label: prepared.batch.label });
      } else {
        setSaveState({ status: "error", message: result.error ?? "Save failed." });
      }
    } catch (error) {
      setSaveState({ status: "error", message: messageOf(error) });
    }
  }, [displayed, selectedFindings, prepareSelection, workspaceId, persistBatches]);

  const handleDeleteBatch = useCallback(
    async (id: string) => {
      setDeletingId(id);
      setDeleteError(null);
      try {
        const current = selectionsRef.current;
        if (current.status !== "ready") {
          setDeleteError("Selection storage is not ready yet.");
          return;
        }
        const remaining = current.values.batches.filter((batch) => batch.id !== id);
        const result = await persistBatches(remaining);
        if (!result.ok) setDeleteError(result.error ?? "Delete failed.");
      } finally {
        setDeletingId(null);
      }
    },
    [persistBatches],
  );

  const batchContext = useMemo(
    () => ({
      workspaceName: workspace?.name ?? workspaceId,
      worktreeRoot:
        capabilities?.gitRoot ?? capabilities?.workspaceDirectory ?? workspace?.directory ?? "",
      sessionId: displayed?.sessionId ?? "",
      mode: displayed?.mode ?? scopeMode,
      baseRef: displayed?.baseRef,
      targetRef: displayed?.targetRef,
    }),
    [workspace, capabilities, displayed, scopeMode, workspaceId],
  );

  const instructions =
    preferences.status === "ready"
      ? preferences.values.newAgentInstructions
      : DEFAULT_NEW_AGENT_INSTRUCTIONS;
  const assembledPrompt = useMemo(
    () => buildAgentPrompt(instructions, selectedFindings, batchContext),
    [instructions, selectedFindings, batchContext],
  );

  const openNewAgentModal = useCallback(async () => {
    setModalOpen(true);
    setModalLoading(true);
    setCreateError(null);
    setCreatedAgentId(null);
    setDefaultSaved(false);
    setDefaultSaveError(null);
    setSuggestedFrom(null);
    try {
      const directory = workspace?.directory ?? undefined;
      let snapshot: PaseoProviderSnapshotResult;
      try {
        snapshot = await paseo.providers.waitForReady(directory ? { cwd: directory } : undefined);
      } catch {
        snapshot = await paseo.providers.snapshot(directory ? { cwd: directory } : undefined);
      }
      const available = collectAvailableModels(snapshot);
      setAvailableModels(available);
      const availableSet = new Set(available);

      let suggestion: { model: string; label: string } | null = null;
      try {
        const collected: Array<{
          workspaceId?: string;
          archivedAt?: string | null;
          provider: string;
          model: string | null;
          title: string | null;
          id: string;
          updatedAt: string;
        }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 4; page += 1) {
          const result = await paseo.agents.list({
            sort: [{ key: "updated_at", direction: "desc" }],
            page: { limit: 50, ...(cursor ? { cursor } : {}) },
          });
          for (const entry of result.entries) {
            collected.push({
              workspaceId: entry.agent.workspaceId,
              archivedAt: entry.agent.archivedAt,
              provider: String(entry.agent.provider),
              model: entry.agent.model,
              title: entry.agent.title,
              id: entry.agent.id,
              updatedAt: entry.agent.updatedAt,
            });
          }
          if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
          cursor = result.pageInfo.nextCursor;
        }
        const mine = collected.filter(
          (agent) => agent.workspaceId === workspaceId && !agent.archivedAt && agent.model,
        );
        mine.sort((a, b) => {
          if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        for (const agent of mine) {
          const candidate = `${agent.provider}/${agent.model}`;
          if (availableSet.has(candidate)) {
            suggestion = { model: candidate, label: agent.title ?? agent.id };
            break;
          }
        }
      } catch {
        suggestion = null;
      }

      const prefs = preferencesRef.current;
      const savedDefault =
        prefs.status === "ready" ? prefs.values.defaultProviderModel : undefined;
      if (savedDefault && availableSet.has(savedDefault)) {
        setChosenModel(savedDefault);
      } else if (suggestion) {
        setChosenModel(suggestion.model);
        setSuggestedFrom(suggestion.label);
      } else {
        setChosenModel("");
      }
    } catch (error) {
      setCreateError(`Could not load available models: ${messageOf(error)}`);
      setAvailableModels([]);
    } finally {
      setModalLoading(false);
    }
  }, [paseo, workspace, workspaceId]);

  const closeNewAgentModal = useCallback(() => {
    if (!creating) setModalOpen(false);
  }, [creating]);

  const handleSaveDefaultModel = useCallback(async () => {
    setDefaultSaveError(null);
    setDefaultSaved(false);
    const prefs = preferencesRef.current;
    if (prefs.status !== "ready") {
      setDefaultSaveError("Preferences are not ready yet.");
      return;
    }
    if (!chosenModel) {
      setDefaultSaveError("Choose a model before saving it as the default.");
      return;
    }
    const saved = await prefs.save(
      { ...prefs.values, defaultProviderModel: chosenModel },
      prefs.revision,
    );
    if (saved) setDefaultSaved(true);
    else setDefaultSaveError(prefs.saveError ?? "Could not save the default model.");
  }, [chosenModel]);

  const handleCreateAgent = useCallback(async () => {
    if (creating) return;
    setCreateError(null);
    setCreatedAgentId(null);
    if (!chosenModel) {
      setCreateError("Choose a provider/model before creating the agent.");
      return;
    }
    if (!availableModels.includes(chosenModel)) {
      setCreateError(
        `Model ${chosenModel} is not currently available in this workspace; pick another model.`,
      );
      return;
    }
    if (selectedFindings.length === 0) {
      setCreateError("Select at least one finding first.");
      return;
    }
    setCreating(true);
    const title = `OpenCodeReview: ${selectedFindings.length} findings in ${batchContext.workspaceName}`;
    try {
      const handle = paseo.workspaces.ref(workspaceId);
      await handle.refresh();
      const agent = await handle.agents.create({
        config: { provider: chosenModel },
        prompt: assembledPrompt,
        title,
      });
      setCreatedAgentId(agent.id);
      navigation?.openAgent({ agentId: agent.id });
    } catch (error) {
      try {
        const recent = await paseo.agents.list({
          sort: [{ key: "updated_at", direction: "desc" }],
          page: { limit: 20 },
        });
        const match = recent.entries.find(
          (entry) =>
            entry.agent.workspaceId === workspaceId &&
            (entry.agent.title === title ||
              (entry.agent.createdAt &&
                Date.now() - Date.parse(entry.agent.createdAt) < 120_000)),
        );
        if (match) {
          setCreatedAgentId(match.agent.id);
          navigation?.openAgent({ agentId: match.agent.id });
          return;
        }
      } catch {
        // Fall through to the original error below.
      }
      setCreateError(
        `${messageOf(error)} Before retrying, check whether the agent was created; creating again may start duplicate work.`,
      );
    } finally {
      setCreating(false);
    }
  }, [
    creating,
    chosenModel,
    availableModels,
    selectedFindings,
    paseo,
    workspaceId,
    assembledPrompt,
    batchContext.workspaceName,
    navigation,
  ]);

  const canRun =
    capabilities !== null &&
    capabilities.isGitRepo &&
    capabilities.ocrAvailable &&
    !starting &&
    !isJobRunning;
  const savedBatches =
    selections.status === "ready" ? selections.values.batches : [];
  const elapsedSecs = review
    ? Math.max(
        0,
        Math.round(
          ((review.finishedAt ? Date.parse(review.finishedAt) : Date.now()) -
            Date.parse(review.startedAt)) /
            1000,
        ),
      )
    : 0;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={styles.screen}>
        <Text style={styles.heading}>OpenCodeReview</Text>
        <Text style={styles.detail}>Workspace: {workspace?.name ?? workspaceId}</Text>
        <Text style={styles.detail}>
          Worktree:{" "}
          {capabilities?.gitRoot ?? capabilities?.workspaceDirectory ?? workspace?.directory ?? "…"}
        </Text>

        {capsLoading ? <ActivityIndicator accessibilityLabel="Loading capabilities" /> : null}
        {capsError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {capsError}
          </Text>
        ) : null}
        {capabilities && !capabilities.isGitRepo ? (
          <Text style={styles.warning}>
            This workspace is not a Git worktree or repository, so reviews are disabled here.
          </Text>
        ) : null}
        {capabilities && !capabilities.ocrAvailable ? (
          <Text style={styles.warning}>
            The opencodereview executable is not available on this host. Install or configure it,
            then reload this panel. No review can run until then.
          </Text>
        ) : null}
        {capabilities?.ocrVersion ? (
          <Text style={styles.detail}>OCR version: {capabilities.ocrVersion}</Text>
        ) : null}

        <Text style={styles.subheading}>Scope</Text>
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Review uncommitted changes"
            accessibilityState={{ selected: scopeMode === "uncommitted" }}
            onPress={() => setScopeMode("uncommitted")}
            style={scopeMode === "uncommitted" ? styles.chipActive : styles.chip}
          >
            <Text style={styles.chipText}>Uncommitted</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Review branch versus base"
            accessibilityState={{ selected: scopeMode === "branch" }}
            onPress={() => setScopeMode("branch")}
            style={scopeMode === "branch" ? styles.chipActive : styles.chip}
          >
            <Text style={styles.chipText}>Branch vs base</Text>
          </Pressable>
        </View>
        {scopeMode === "branch" ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.detail}>
              Reviews commits introduced by the target since its merge-base with the base. It does
              not include uncommitted work, even when the target is the checked-out branch.
            </Text>
            {refsError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {refsError}
              </Text>
            ) : null}
            <Text style={styles.detail}>Target</Text>
            <TextInput
              accessibilityLabel="Target branch ref"
              value={target}
              onChangeText={setTarget}
              placeholder="e.g. feature-branch"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            <Text style={styles.detail}>Base</Text>
            <TextInput
              accessibilityLabel="Base branch ref"
              value={base}
              onChangeText={setBase}
              placeholder="e.g. main"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            {refs && refs.branches.length > 0 ? (
              <View style={styles.row}>
                {refs.branches.slice(0, 30).map((branch) => (
                  <Pressable
                    key={`${branch.isRemote ? "remote" : "local"}:${branch.name}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Use branch ${branch.name} as target`}
                    onPress={() => setTarget(branch.name)}
                    style={styles.chip}
                  >
                    <Text style={styles.chipText}>
                      {branch.name}
                      {branch.isCurrent ? " (current)" : ""}
                      {branch.isRemote ? " (remote)" : ""}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <Text style={styles.detail}>
            Reviews staged, unstaged, and untracked changes together.
          </Text>
        )}

        {startError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {startError}
          </Text>
        ) : null}
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Run OpenCodeReview"
            accessibilityState={{ disabled: !canRun }}
            disabled={!canRun}
            onPress={() => void handleStart()}
            style={canRun ? styles.button : styles.buttonDisabled}
          >
            <Text style={canRun ? styles.buttonText : styles.buttonTextDisabled}>
              {starting ? "Starting…" : isJobRunning ? "Review running…" : "Run review"}
            </Text>
          </Pressable>
          {isJobRunning && jobId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel running review"
              accessibilityState={{ disabled: cancelling }}
              disabled={cancelling}
              onPress={() => void handleCancel()}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{cancelling ? "Cancelling…" : "Cancel"}</Text>
            </Pressable>
          ) : null}
        </View>
        {review?.status === "running" ? (
          <Text style={styles.detail}>Running… elapsed {elapsedSecs}s. Polling every 2s.</Text>
        ) : null}
        {reviewError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {reviewError}
          </Text>
        ) : null}

        {review ? (
          <View style={styles.card}>
            <Text style={styles.subheading}>
              {describeStatus(review.status, review.findings.length)}
            </Text>
            <Text style={styles.detail}>
              Mode: {review.mode}
              {review.targetRef ? ` Target: ${review.targetRef}` : ""}
              {review.baseRef ? ` Base: ${review.baseRef}` : ""}
            </Text>
            {review.sessionId ? (
              <Text style={styles.detail}>Session: {review.sessionId}</Text>
            ) : null}
            <Text style={styles.detail}>
              Reviewed: {review.counts.completed ?? "?"} Selected: {review.counts.selected ?? "?"}{" "}
              Failed: {review.counts.failed ?? "?"}
            </Text>
            {review.warnings.length > 0 ? (
              <Text style={styles.warning}>Warnings: {review.warnings.join("; ")}</Text>
            ) : null}
            {review.message ? <Text style={styles.detail}>{review.message}</Text> : null}
          </View>
        ) : null}

        <Text style={styles.subheading}>
          Findings{findings.length > 0 ? ` (${findings.length})` : ""}
          {displayed?.sessionId ? ` — ${displayed.sessionId}` : ""}
        </Text>
        {findings.length > 0 ? (
          <View style={{ gap: 8 }}>
            <View style={styles.row}>
              {PRESETS.map((preset) => (
                <Pressable
                  key={preset.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${preset.label} findings, replacing current selection`}
                  onPress={() => applyPreset(preset.id)}
                  style={styles.chip}
                >
                  <Text style={styles.chipText}>{preset.label}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear finding selection"
                onPress={clearSelection}
                style={styles.chip}
              >
                <Text style={styles.chipText}>Clear</Text>
              </Pressable>
            </View>
            <Text style={styles.detail}>
              Selected {selectedFindings.length} of {findings.length}
              {severitySummary ? ` (${severitySummary})` : ""}. Presets replace the selection.
            </Text>
            {review?.status === "partial" ? (
              <Text style={styles.warning}>
                This review has incomplete coverage; the selection covers available findings only.
              </Text>
            ) : null}
            {findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                checked={checked.has(finding.id)}
                onToggle={() => toggleFinding(finding.id)}
                theme={theme}
                compact={layout.compact}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.detail}>
            {review && review.status !== "running"
              ? "No findings in the current review."
              : "Run a review or load a session from history to see findings here."}
          </Text>
        )}

        <Text style={styles.subheading}>Existing-agent handoff</Text>
        <Text style={styles.detail}>
          Save the selection as one immutable batch, then open the desired agent&apos;s composer →
          Add attachment → OpenCodeReview selections → choose this batch. Saved batches are visible
          to every client of this host.
        </Text>
        {saveState.status === "saved" ? (
          <Text style={styles.success}>
            Saved “{saveState.label}” (id {saveState.batchId}). Reopen the picker and search by its
            label if the list looks stale; the picker caches results briefly.
          </Text>
        ) : null}
        {saveState.status === "error" ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {saveState.message}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save selection for chat"
          accessibilityState={{
            disabled: selectedFindings.length === 0 || saveState.status === "saving",
          }}
          disabled={selectedFindings.length === 0 || saveState.status === "saving"}
          onPress={() => void handleSaveSelection()}
          style={
            selectedFindings.length === 0 || saveState.status === "saving"
              ? styles.buttonDisabled
              : styles.button
          }
        >
          <Text
            style={
              selectedFindings.length === 0 || saveState.status === "saving"
                ? styles.buttonTextDisabled
                : styles.buttonText
            }
          >
            {saveState.status === "saving"
              ? "Saving…"
              : `Save selection for chat (${selectedFindings.length})`}
          </Text>
        </Pressable>
        {!displayed?.sessionId && findings.length > 0 ? (
          <Text style={styles.warning}>
            The current run has no OCR session ID, so it cannot be saved yet.
          </Text>
        ) : null}

        {savedBatches.length > 0 ? (
          <View style={{ gap: 8 }}>
            {savedBatches.map((batch) => (
              <View key={batch.id} style={styles.card}>
                <Text style={styles.detail}>
                  {batch.label} — {batch.workspaceName} — session {batch.sessionId}
                </Text>
                <Text style={styles.detail}>Saved {batch.createdAt}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete saved batch ${batch.label}`}
                  accessibilityState={{ disabled: deletingId === batch.id }}
                  disabled={deletingId === batch.id}
                  onPress={() => void handleDeleteBatch(batch.id)}
                >
                  <Text style={styles.error}>
                    {deletingId === batch.id ? "Deleting…" : "Delete"}
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.detail}>No saved batches yet on this host.</Text>
        )}
        {deleteError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {deleteError}
          </Text>
        ) : null}

        <Text style={styles.subheading}>New-agent handoff</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start new agent with selection"
          accessibilityState={{ disabled: selectedFindings.length === 0 }}
          disabled={selectedFindings.length === 0}
          onPress={() => void openNewAgentModal()}
          style={selectedFindings.length === 0 ? styles.buttonDisabled : styles.button}
        >
          <Text
            style={
              selectedFindings.length === 0 ? styles.buttonTextDisabled : styles.buttonText
            }
          >
            {`Start new agent with selection (${selectedFindings.length})`}
          </Text>
        </Pressable>

        <Text style={styles.subheading}>History</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh review history"
          accessibilityState={{ disabled: historyLoading }}
          disabled={historyLoading}
          onPress={() => void refreshHistory()}
          style={styles.chip}
        >
          <Text style={styles.chipText}>{historyLoading ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
        {historyError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {historyError}
          </Text>
        ) : null}
        {sessionError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {sessionError}
          </Text>
        ) : null}
        {history.length === 0 && !historyLoading ? (
          <Text style={styles.detail}>No previous sessions for this worktree.</Text>
        ) : null}
        {history.map((session) => (
          <View key={session.sessionId} style={styles.card}>
            <Text style={styles.detail}>
              {session.sessionId} — {session.reviewMode}
              {session.totalComments !== undefined ? ` — ${session.totalComments} comments` : ""}
            </Text>
            {session.createdAt ? (
              <Text style={styles.detail}>Created {session.createdAt}</Text>
            ) : null}
            {session.gitBranch ? (
              <Text style={styles.detail}>Branch {session.gitBranch}</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Load session ${session.sessionId}`}
              accessibilityState={{ disabled: sessionLoadingId === session.sessionId }}
              disabled={sessionLoadingId === session.sessionId}
              onPress={() => void handleLoadSession(session)}
            >
              <Text style={styles.detail}>
                {sessionLoadingId === session.sessionId ? "Loading…" : "Load"}
              </Text>
            </Pressable>
          </View>
        ))}

        <Modal
          visible={modalOpen}
          animationType="slide"
          onRequestClose={closeNewAgentModal}
          transparent={false}
        >
          <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
            <View style={styles.screen}>
              <Text style={styles.heading}>Start new agent</Text>
              <Text style={styles.detail}>Workspace: {batchContext.workspaceName}</Text>
              <Text style={styles.detail}>
                Selection: {selectedFindings.length} findings
                {severitySummary ? ` (${severitySummary})` : ""}
              </Text>
              <Text style={styles.warning}>
                Confirming creates the agent immediately and starts work; it does not populate an
                editable draft.
              </Text>
              <Text style={styles.subheading}>Instructions</Text>
              <Text style={styles.detail}>{instructions}</Text>
              <Text style={styles.detail}>
                Edit the default instructions in plugin settings → OpenCodeReview. The full findings
                below are always appended.
              </Text>
              <Text style={styles.subheading}>Prompt preview</Text>
              <Text style={styles.detail}>{assembledPrompt}</Text>
              <Text style={styles.subheading}>Model</Text>
              {modalLoading ? (
                <ActivityIndicator accessibilityLabel="Loading available models" />
              ) : (
                <View style={{ gap: 8 }}>
                  {suggestedFrom ? (
                    <Text style={styles.detail}>
                      Suggested from your most recently updated agent in this workspace (“
                      {suggestedFrom}”). This is a suggestion, not necessarily the focused chat.
                    </Text>
                  ) : null}
                  <SettingsSelect
                    label="Provider and model"
                    hint={
                      chosenModel &&
                      preferences.status === "ready" &&
                      preferences.values.defaultProviderModel === chosenModel
                        ? "Saved default"
                        : "Choose a model"
                    }
                    value={chosenModel}
                    options={availableModels.map((model) => ({ label: model, value: model }))}
                    disabled={creating}
                    onValueChange={setChosenModel}
                  />
                  {availableModels.length > 0 ? null : (
                    <Text style={styles.warning}>
                      No models are currently available in this workspace.
                    </Text>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Save chosen model as default"
                    onPress={() => void handleSaveDefaultModel()}
                    style={styles.chip}
                  >
                    <Text style={styles.chipText}>Save as default</Text>
                  </Pressable>
                  {defaultSaved ? (
                    <Text style={styles.success}>Default model saved.</Text>
                  ) : null}
                  {defaultSaveError ? (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {defaultSaveError}
                    </Text>
                  ) : null}
                </View>
              )}
              {createError ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  {createError}
                </Text>
              ) : null}
              {createdAgentId ? (
                <Text style={styles.success}>Created agent {createdAgentId}.</Text>
              ) : null}
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Confirm and create agent"
                  accessibilityState={{ disabled: creating || modalLoading }}
                  disabled={creating || modalLoading}
                  onPress={() => void handleCreateAgent()}
                  style={creating || modalLoading ? styles.buttonDisabled : styles.button}
                >
                  <Text style={creating || modalLoading ? styles.buttonTextDisabled : styles.buttonText}>
                    {creating ? "Creating…" : "Confirm and create"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close new agent dialog"
                  accessibilityState={{ disabled: creating }}
                  disabled={creating}
                  onPress={closeNewAgentModal}
                  style={styles.chip}
                >
                  <Text style={styles.chipText}>Close</Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </Modal>
      </View>
    </ScrollView>
  );
}

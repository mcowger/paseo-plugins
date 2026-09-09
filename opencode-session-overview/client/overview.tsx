import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  countCompletedTasks,
  contextPercent,
  extractTasks,
  formatCost,
  formatTokens,
  OVERVIEW_REFRESH_INTERVAL_MS,
  type OverviewSubagent,
  type OverviewTask,
  type OverviewUsage,
} from "../shared/overview";

const TIMELINE_PAGE_SIZE = 250;
const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "opencode-session-overview-agents";
const REFRESH_DEBOUNCE_MS = 250;

type OverviewState = {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly sessionId: string | null;
  readonly usage: OverviewUsage | null;
  readonly tasks: readonly OverviewTask[];
  readonly subagents: readonly OverviewSubagent[];
  readonly commands: { count: number; skills: number; error: string | null };
  readonly workspace: PaseoWorkspace | null;
};

const EMPTY_STATE: OverviewState = {
  loaded: false,
  loading: false,
  error: null,
  sessionId: null,
  usage: null,
  tasks: [],
  subagents: [],
  commands: { count: 0, skills: 0, error: null },
  workspace: null,
};

function usageFromAgent(agent: PaseoAgent | null): OverviewUsage | null {
  const usage = agent?.lastUsage;
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalCostUsd: usage.totalCostUsd ?? 0,
    contextWindowMaxTokens: usage.contextWindowMaxTokens ?? null,
    contextWindowUsedTokens: usage.contextWindowUsedTokens ?? null,
  };
}

function sessionIdsFromItems(items: readonly AgentTimelineItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool_call" || item.detail.type !== "sub_agent") continue;
    if (item.detail.childSessionId) ids.add(item.detail.childSessionId);
  }
  return ids;
}

async function listAgents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const response = await paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      ...(cursor ? {} : { subscribe: { subscriptionId: AGENT_SUBSCRIPTION_ID } }),
    });
    agents.push(...response.entries.map(({ agent }) => agent));
    cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return agents;
}

function useSessionOverview(agentId: string, workspaceId: string, enabled: boolean): OverviewState {
  const paseo = usePaseo();
  const agentHandle = useMemo(() => paseo.agents.ref(agentId), [agentId, paseo]);
  const workspaceHandle = useMemo(() => paseo.workspaces.ref(workspaceId), [paseo, workspaceId]);
  const [state, setState] = useState<OverviewState>(EMPTY_STATE);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY_STATE);
      return;
    }
    let stopped = false;
    let refreshing = false;
    let refreshQueued = false;
    let refreshGeneration = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async () => {
      if (stopped) return;
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      const generation = ++refreshGeneration;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const [agentResult, timelineResult, workspaceResult, commandResult, agentsResult] = await Promise.all([
          agentHandle.refresh(),
          agentHandle.timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE_SIZE, projection: "projected" }),
          workspaceHandle.refresh(),
          agentHandle.commands(),
          listAgents(paseo),
        ]);
        if (stopped || generation !== refreshGeneration) return;

        const agent = agentResult?.agent ?? agentHandle.current();
        const items = timelineResult.entries.map((entry) => entry.item);
        const childSessionIds = sessionIdsFromItems(items);
        const subagents = agentsResult
          .filter((candidate) => {
            if (candidate.id === agentId || candidate.workspaceId !== workspaceId) return false;
            const sessionId = candidate.runtimeInfo?.sessionId;
            return sessionId ? childSessionIds.has(sessionId) : false;
          })
          .map((candidate) => ({
            id: candidate.id,
            title: candidate.title ?? "Untitled subagent",
            provider: candidate.provider,
            status: candidate.status,
            model: candidate.model,
            cost: candidate.lastUsage?.totalCostUsd ?? null,
          }));
        setState({
          loaded: true,
          loading: false,
          error: null,
          sessionId: agent?.runtimeInfo?.sessionId ?? null,
          usage: usageFromAgent(agent),
          tasks: extractTasks(items),
          subagents,
          commands: {
            count: commandResult.commands.length,
            skills: commandResult.commands.filter((command) => command.kind === "skill").length,
            error: commandResult.error,
          },
          workspace: workspaceResult,
        });
      } catch (error) {
        if (!stopped && generation === refreshGeneration) {
          setState((current) => ({
            ...current,
            loaded: true,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        refreshing = false;
        if (!stopped && refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    };

    const scheduleRefresh = () => {
      if (stopped || refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    };
    const onAgentUpdate = () => scheduleRefresh();
    const onTimelineEvent = (stream: { event: { type: string; sessionId?: string } }) => {
      if (stream.event.type === "thread_started" && stream.event.sessionId) {
        setState((current) => ({ ...current, sessionId: stream.event.sessionId ?? null }));
      }
      scheduleRefresh();
    };
    const unsubscribeAgent = agentHandle.subscribe(onAgentUpdate);
    const unsubscribeTimeline = agentHandle.timeline.subscribe(onTimelineEvent);
    const unsubscribeAgents = paseo.agents.subscribe((update) => {
      if (update.kind === "remove") {
        if (update.agentId === agentId) scheduleRefresh();
        return;
      }
      if (update.agent.id === agentId || update.agent.workspaceId === workspaceId) scheduleRefresh();
    });
    const interval = setInterval(() => {
      if (agentHandle.status === "running") void refresh();
    }, OVERVIEW_REFRESH_INTERVAL_MS);
    void refresh();

    return () => {
      stopped = true;
      refreshGeneration += 1;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unsubscribeAgent();
      unsubscribeTimeline();
      unsubscribeAgents();
      clearInterval(interval);
    };
  }, [agentHandle, agentId, enabled, paseo, workspaceHandle, workspaceId]);

  return state;
}

function useOverviewStyles(theme: PluginAgentPanelProps["theme"], compact: boolean) {
  return useMemo(
    () => ({
      screen: {
        flex: 1,
        gap: compact ? 10 : 12,
        padding: compact ? 12 : 20,
        backgroundColor: theme.colors.surface0,
      },
      card: {
        gap: compact ? 8 : 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 14,
        backgroundColor: theme.colors.surface1,
      },
      header: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 21, fontWeight: "600" as const },
      heading: { color: theme.colors.foreground, fontSize: compact ? 14 : 15, fontWeight: "600" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, flexShrink: 1 },
      muted: { color: theme.colors.foregroundMuted },
      accent: { color: theme.colors.accent },
      success: { color: theme.colors.statusSuccess },
      warning: { color: theme.colors.statusWarning },
      danger: { color: theme.colors.statusDanger },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      task: { flexDirection: "row" as const, gap: 8 },
      taskText: { color: theme.colors.foreground, flex: 1 },
      completedText: { color: theme.colors.foregroundMuted, flex: 1 },
      divider: { height: 1, backgroundColor: theme.colors.border },
    }),
    [compact, theme],
  );
}

function statusColor(
  status: "initializing" | "idle" | "running" | "error" | "closed",
  styles: ReturnType<typeof useOverviewStyles>,
) {
  if (status === "running") return styles.accent;
  if (status === "error") return styles.danger;
  if (status === "closed") return styles.muted;
  return styles.success;
}

function Metric({ label, value, styles }: { label: string; value: string; styles: ReturnType<typeof useOverviewStyles> }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text numberOfLines={1} style={styles.value}>{value}</Text>
    </View>
  );
}

function TaskRows({ tasks, styles }: { tasks: readonly OverviewTask[]; styles: ReturnType<typeof useOverviewStyles> }) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.heading}>Tasks</Text>
        <Text style={styles.muted}>{countCompletedTasks(tasks)}/{tasks.length}</Text>
      </View>
      {tasks.map((task) => (
        <View key={task.id} style={styles.task}>
          <Text style={task.status === "completed" ? styles.success : task.status === "in_progress" ? styles.accent : styles.muted}>
            {task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○"}
          </Text>
          <Text numberOfLines={2} style={task.status === "completed" ? styles.completedText : styles.taskText}>{task.text}</Text>
        </View>
      ))}
    </View>
  );
}

export function OpenCodeSessionOverviewPanel({ theme, layout, agentId, workspaceId }: PluginAgentPanelProps) {
  const agent = useAgent(agentId, (snapshot) => snapshot);
  const workspace = useWorkspace(workspaceId, (snapshot) => snapshot);
  const isOpenCode = agent ? agent.provider === "opencode" || agent.provider.startsWith("opencode/") : false;
  const overview = useSessionOverview(agentId, workspaceId, isOpenCode);
  const styles = useOverviewStyles(theme, layout.compact);
  const usage = overview.usage;
  const percentage = contextPercent(usage);
  const tasks = overview.tasks;
  if (!agent || !isOpenCode) {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>OpenCode session</Text>
        <View style={styles.card}>
          <Text style={styles.muted}>This agent uses {agent?.provider ?? "an unavailable provider"}.</Text>
          <Text style={styles.label}>The overview is available for OpenCode agents only.</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.title}>{agent.title ?? "OpenCode session"}</Text>
          <Text numberOfLines={1} style={styles.label}>{agent.cwd}</Text>
        </View>
        <Icon name="Activity" size={20} color={statusColor(agent.status, styles).color} />
      </View>

      {overview.error ? <Text style={styles.danger}>Unable to refresh: {overview.error}</Text> : null}
      {!overview.loaded && overview.loading ? <Text style={styles.muted}>Loading session details…</Text> : null}

      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.heading}>Session</Text>
          <Text style={statusColor(agent.status, styles)}>{agent.status}</Text>
        </View>
        <Metric label="Context" value={percentage === null ? "—" : `${percentage}% · ${formatTokens(usage?.contextWindowUsedTokens)}`} styles={styles} />
        <Metric label="Last turn cost" value={formatCost(usage?.totalCostUsd)} styles={styles} />
        <Metric label="Last turn tokens" value={`${formatTokens((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))} · ${formatTokens(usage?.outputTokens)}`} styles={styles} />
        <Metric label="OpenCode session" value={overview.sessionId ? overview.sessionId.slice(0, 12) : "Not started"} styles={styles} />
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Project</Text>
        <Metric label="Repository" value={overview.workspace?.projectDisplayName ?? workspace?.projectDisplayName ?? "—"} styles={styles} />
        <Metric label="Directory" value={overview.workspace?.workspaceDirectory ?? workspace?.directory ?? agent.cwd} styles={styles} />
        <Metric label="Branch" value={overview.workspace?.gitRuntime?.currentBranch ?? "—"} styles={styles} />
        <Metric
          label="Ahead / behind"
          value={overview.workspace?.gitRuntime?.aheadBehind
            ? `↑${overview.workspace.gitRuntime.aheadBehind.ahead} · ↓${overview.workspace.gitRuntime.aheadBehind.behind}`
            : "—"}
          styles={styles}
        />
        <Metric
          label="Workspace diff"
          value={overview.workspace?.diffStat ? `+${overview.workspace.diffStat.additions} / −${overview.workspace.diffStat.deletions}` : "—"}
          styles={styles}
        />
      </View>

      {overview.subagents.length > 0 ? (
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.heading}>Subagents</Text>
            <Text style={styles.muted}>{overview.subagents.length}</Text>
          </View>
          {overview.subagents.map((subagent) => (
            <View key={subagent.id} style={styles.row}>
              <Text numberOfLines={1} style={styles.value}>{subagent.title}</Text>
              <Text style={statusColor(subagent.status, styles)}>{formatCost(subagent.cost)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {tasks.length > 0 ? <TaskRows tasks={tasks} styles={styles} /> : null}

      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.heading}>Context sources</Text>
          <Text style={styles.muted}>{overview.commands.skills} skills · {overview.commands.count} commands</Text>
        </View>
        {overview.commands.error ? <Text style={styles.label}>{overview.commands.error}</Text> : null}
        {!overview.commands.error && overview.commands.count === 0 ? <Text style={styles.muted}>No session commands reported.</Text> : null}
      </View>
    </ScrollView>
  );
}

import { useAgent } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import { useEffect, useMemo, useState } from "react";
import {
  formatRelativeTime,
  formatUsage,
  getDescendantTree,
  getAgentDisplayName,
  getProviderSubagentActivities,
  isArchived,
  type AgentTreeNode,
  type ProviderSubagentActivity,
  type ToolCallActivity,
} from "../shared/subagent-activity";
import { useSubagentActivity } from "./subagent-activity-state";

const STATUS_SYMBOLS = {
  initializing: "◌",
  idle: "○",
  running: "◉",
  error: "×",
  closed: "■",
} as const;

type Status = keyof typeof STATUS_SYMBOLS;

export function SubagentActivityPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const state = useSubagentActivity(agentId, showArchived);
  const parentTitle = useAgent(agentId, (agent) => agent.title);
  const styles = usePanelStyles(theme, layout.compact);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const tree = useMemo(
    () => getDescendantTree(state.agents, agentId),
    [agentId, state.agents],
  );
  const activeTree = tree.filter(({ agent }) => !isArchived(agent));
  const archivedTree = tree.filter(({ agent }) => isArchived(agent));
  const providerActivities = useMemo(() => {
    const activities = new Map(state.providerActivities.map((activity) => [activity.id, activity]));
    for (const activity of state.activities.values()) {
      for (const providerActivity of getProviderSubagentActivities(activity.toolCalls)) {
        activities.set(providerActivity.id, providerActivity);
      }
    }
    return [...activities.values()].sort(
      (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
    );
  }, [state.activities, state.providerActivities]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.headingRow}>
          <Icon name="Bot" size={layout.compact ? 18 : 20} color={theme.colors.accent} />
          <View style={styles.headingText}>
            <Text style={styles.title}>Subagent activity</Text>
            <Text numberOfLines={1} style={styles.subtitle}>
              {parentTitle?.trim() || "Selected agent"}
            </Text>
          </View>
        </View>
        <View style={styles.counts}>
          <Text style={styles.count}>{activeTree.length} active</Text>
          <Text style={styles.count}>{archivedTree.length} archived</Text>
        </View>
      </View>

      {state.loading && state.agents.length === 0 ? (
        <Text style={styles.detail}>Loading subagents…</Text>
      ) : null}
      {state.error ? <Text style={styles.error}>Unable to load subagents: {state.error}</Text> : null}

      {!state.loading && !state.error && activeTree.length === 0 ? (
        <EmptyCard compact={layout.compact} theme={theme} text="No active managed subagents." />
      ) : null}
      {activeTree.map((node) => (
        <ManagedAgentRow
          key={node.agent.id}
          node={node}
          activity={state.activities.get(node.agent.id)}
          now={now}
          theme={theme}
          compact={layout.compact}
        />
      ))}

      {archivedTree.length > 0 ? (
        <View style={styles.archiveSection}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${showArchived ? "Hide" : "Show"} archived subagents`}
            onPress={() => setShowArchived((visible) => !visible)}
            style={styles.archiveHeader}
          >
            <Text style={styles.disclosure}>{showArchived ? "▾" : "▸"}</Text>
            <Icon name="Archive" size={16} color={theme.colors.foregroundMuted} />
            <Text style={styles.archiveTitle}>Archived subagents</Text>
            <Text style={styles.archiveCount}>{archivedTree.length}</Text>
          </Pressable>
          {showArchived
            ? archivedTree.map((node) => (
                <ManagedAgentRow
                  key={node.agent.id}
                  node={node}
                  activity={state.activities.get(node.agent.id)}
                  now={now}
                  theme={theme}
                  compact={layout.compact}
                />
              ))
            : null}
        </View>
      ) : null}

      {state.providerLoading && providerActivities.length === 0 ? (
        <Text style={styles.detail}>Loading provider subagent activity…</Text>
      ) : null}
      {state.providerError ? (
        <Text style={styles.error}>Unable to load provider activity: {state.providerError}</Text>
      ) : null}
      {providerActivities.length > 0 ? (
        <View style={styles.providerSection}>
          <View style={styles.sectionHeading}>
            <Icon name="Sparkles" size={16} color={theme.colors.accent} />
            <Text style={styles.sectionTitle}>Provider subagent activity</Text>
          </View>
          <Text style={styles.disclaimer}>
            Native provider workers are shown from the parent timeline and may not expose model or token data.
          </Text>
          {providerActivities.map((activity) => (
            <ProviderActivityRow key={activity.id} activity={activity} theme={theme} compact={layout.compact} now={now} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function ManagedAgentRow({
  node,
  activity,
  now,
  theme,
  compact,
}: {
  node: AgentTreeNode;
  activity:
    | {
        readonly toolCalls: readonly ToolCallActivity[];
        readonly lastActivityAt: string;
        readonly loading: boolean;
        readonly error: string | null;
      }
    | undefined;
  now: number;
  theme: PluginTheme;
  compact: boolean;
}) {
  const styles = usePanelStyles(theme, compact, node.depth);
  const { agent } = node;
  const status = asStatus(agent.status);
  const toolCalls = activity?.toolCalls ?? [];
  const lastActivityAt = activity?.lastActivityAt || agent.updatedAt;
  return (
    <View style={styles.agentCard}>
      <View style={styles.agentHeader}>
        <View style={styles.agentTitleRow}>
          <Text style={[styles.status, { color: statusColor(theme, status) }]}>{STATUS_SYMBOLS[status]}</Text>
          <Text numberOfLines={1} style={styles.agentTitle}>
            {getAgentDisplayName(agent)}
          </Text>
        </View>
        <Text style={styles.statusLabel}>{agent.status}</Text>
      </View>
      <View style={styles.metadataRow}>
        <Text numberOfLines={1} style={styles.metadata}>
          {agent.provider} · {agent.model || "model unavailable"}
        </Text>
        <Text style={styles.metadata}>{formatUsage(agent.lastUsage)}</Text>
      </View>
      <Text style={styles.activityLabel}>Last activity: {formatRelativeTime(lastActivityAt, now)}</Text>
      {activity?.error ? <Text style={styles.error}>Tool activity unavailable: {activity.error}</Text> : null}
      {activity?.loading && toolCalls.length === 0 ? <Text style={styles.detail}>Loading tool calls…</Text> : null}
      {toolCalls.length > 0 ? (
        <View style={styles.toolList}>
          {toolCalls.map((toolCall) => (
            <ToolCallRow key={toolCall.id} activity={toolCall} theme={theme} compact={compact} now={now} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ToolCallRow({
  activity,
  theme,
  compact,
  now,
}: {
  activity: ToolCallActivity;
  theme: PluginTheme;
  compact: boolean;
  now: number;
}) {
  const styles = usePanelStyles(theme, compact);
  return (
    <View style={styles.toolRow}>
      <Text style={[styles.toolStatus, { color: toolStatusColor(theme, activity.status) }]}>
        {toolStatusSymbol(activity.status)}
      </Text>
      <View style={styles.toolText}>
        <View style={styles.toolHeading}>
          <Text numberOfLines={1} style={styles.toolName}>
            {activity.name}
          </Text>
          <Text style={styles.toolTime}>{formatRelativeTime(activity.timestamp, now)}</Text>
        </View>
        <Text numberOfLines={2} style={styles.toolSummary}>
          {activity.summary}
        </Text>
      </View>
    </View>
  );
}

function ProviderActivityRow({
  activity,
  theme,
  compact,
  now,
}: {
  activity: ProviderSubagentActivity;
  theme: PluginTheme;
  compact: boolean;
  now: number;
}) {
  const styles = usePanelStyles(theme, compact);
  return (
    <View style={styles.providerCard}>
      <View style={styles.agentHeader}>
        <View style={styles.agentTitleRow}>
          <Text style={[styles.status, { color: toolStatusColor(theme, activity.status) }]}>
            {toolStatusSymbol(activity.status)}
          </Text>
          <Text numberOfLines={2} style={styles.agentTitle}>
            {activity.title}
          </Text>
        </View>
        <Text style={styles.statusLabel}>{activity.status}</Text>
      </View>
      <Text style={styles.metadata}>
        {activity.toolName} · {formatRelativeTime(activity.timestamp, now)}
      </Text>
      {activity.subagentType ? <Text style={styles.metadata}>type {activity.subagentType}</Text> : null}
      {activity.childSessionId ? (
        <Text numberOfLines={1} style={styles.metadata}>
          session {activity.childSessionId}
        </Text>
      ) : null}
      {activity.log ? <Text numberOfLines={3} style={styles.toolSummary}>{activity.log}</Text> : null}
      {activity.actions.length > 0 ? (
        <View style={styles.providerActions}>
          {activity.actions.map((action) => (
            <Text key={`${activity.id}-${action.toolName}-${action.summary ?? ""}`} numberOfLines={1} style={styles.toolSummary}>
              {action.toolName}{action.summary ? ` · ${action.summary}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function EmptyCard({ compact, theme, text }: { compact: boolean; theme: PluginTheme; text: string }) {
  const styles = usePanelStyles(theme, compact);
  return (
    <View style={styles.emptyCard}>
      <Text style={styles.detail}>{text}</Text>
    </View>
  );
}

function usePanelStyles(theme: PluginTheme, compact: boolean, depth = 0) {
  return useMemo(
    () => ({
      content: {
        padding: compact ? 12 : 20,
        gap: compact ? 8 : 12,
        backgroundColor: theme.colors.surface0,
      },
      header: {
        gap: 8,
        paddingBottom: compact ? 4 : 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      headingRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      headingText: { flex: 1, minWidth: 0 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 22, fontWeight: "600" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
      counts: { flexDirection: "row" as const, gap: 12 },
      count: { color: theme.colors.foregroundMuted, fontSize: 12 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      agentCard: {
        gap: 6,
        marginLeft: depth * (compact ? 12 : 18),
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 12,
        backgroundColor: theme.colors.surface1,
      },
      providerCard: {
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 12,
        backgroundColor: theme.colors.surface2,
      },
      agentHeader: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      agentTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7, flex: 1, minWidth: 0 },
      status: { fontSize: 15, fontWeight: "700" as const },
      agentTitle: { color: theme.colors.foreground, fontWeight: "600" as const, flex: 1 },
      statusLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
      metadataRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      metadata: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      activityLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
      toolList: { gap: 5, paddingTop: 3 },
      toolRow: { flexDirection: "row" as const, gap: 7, paddingTop: 4 },
      toolStatus: { fontSize: 12, width: 12 },
      toolText: { flex: 1, minWidth: 0, gap: 2 },
      toolHeading: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 6 },
      toolName: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const, flexShrink: 1 },
      toolTime: { color: theme.colors.foregroundMuted, fontSize: 11 },
      toolSummary: { color: theme.colors.foregroundMuted, fontSize: 12 },
      emptyCard: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 12 : 16,
        backgroundColor: theme.colors.surface1,
      },
      archiveSection: { gap: 8, paddingTop: 4 },
      archiveHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 7,
        paddingVertical: 8,
      },
      disclosure: { color: theme.colors.foregroundMuted, width: 12 },
      archiveTitle: { color: theme.colors.foreground, fontWeight: "600" as const, flex: 1 },
      archiveCount: { color: theme.colors.foregroundMuted },
      providerSection: { gap: 8, paddingTop: 4 },
      sectionHeading: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
      sectionTitle: { color: theme.colors.foreground, fontWeight: "600" as const },
      disclaimer: { color: theme.colors.foregroundMuted, fontSize: 12 },
      providerActions: { gap: 3, paddingTop: 2 },
    }),
    [compact, theme],
  );
}

function asStatus(status: string): Status {
  return Object.prototype.hasOwnProperty.call(STATUS_SYMBOLS, status) ? (status as Status) : "idle";
}

function statusColor(theme: PluginTheme, status: Status): string {
  if (status === "running") return theme.colors.accent;
  if (status === "error") return theme.colors.statusDanger;
  if (status === "closed") return theme.colors.foregroundMuted;
  return theme.colors.statusWarning;
}

function toolStatusSymbol(status: ToolCallActivity["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "×";
  if (status === "canceled") return "–";
  return "◐";
}

function toolStatusColor(theme: PluginTheme, status: ToolCallActivity["status"]): string {
  if (status === "completed") return theme.colors.statusSuccess;
  if (status === "failed") return theme.colors.statusDanger;
  if (status === "running") return theme.colors.accent;
  return theme.colors.statusWarning;
}

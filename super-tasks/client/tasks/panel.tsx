import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginHostProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  RefreshControl,
  ScrollView,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { TooltipPressable as Pressable } from "../ui/tooltip";
import { openAgentInPaseoWorkspace } from "../agents/navigation";
import {
  sumCounts,
  type AgentTasksGroup,
  type TaskItemViewModel,
  type TaskStatusFilter,
} from "./model";
import { TaskStatusIcon } from "./status-icon";
import { useWorkspaceTaskGroups } from "./use-workspace-task-groups";

const AGENT_TITLE_COLUMN_STYLE: ViewStyle = { flexShrink: 1 };
const TOUCH_HIT_SLOP = { top: 10, right: 10, bottom: 10, left: 10 } as const;

interface TasksPanelStyles {
  readonly screen: ViewStyle;
  readonly header: ViewStyle;
  readonly headerTitle: TextStyle;
  readonly headerActions: ViewStyle;
  readonly refreshButton: ViewStyle;
  readonly refreshButtonDisabled: ViewStyle;
  readonly filterBar: ViewStyle;
  readonly filterPill: ViewStyle;
  readonly filterPillSelected: ViewStyle;
  readonly filterPillText: TextStyle;
  readonly filterPillTextSelected: TextStyle;
  readonly scrollArea: ViewStyle;
  readonly scrollContent: ViewStyle;
  readonly agentCard: ViewStyle;
  readonly agentCardHeader: ViewStyle;
  readonly agentIdentity: ViewStyle;
  readonly agentTitleText: TextStyle;
  readonly agentMetaText: TextStyle;
  readonly badgeRow: ViewStyle;
  readonly statusBadge: ViewStyle;
  readonly statusBadgeText: TextStyle;
  readonly countPill: ViewStyle;
  readonly countPillText: TextStyle;
  readonly taskList: ViewStyle;
  readonly taskRow: ViewStyle;
  readonly taskOwnerLink: ViewStyle;
  readonly completedToggle: ViewStyle;
  readonly completedToggleText: TextStyle;
  readonly statusIconSlot: ViewStyle;
  readonly taskBody: ViewStyle;
  readonly taskText: TextStyle;
  readonly taskTextCompleted: TextStyle;
  readonly activeFormText: TextStyle;
  readonly stateContainer: ViewStyle;
  readonly stateTitle: TextStyle;
  readonly stateSubtitle: TextStyle;
  readonly errorContainer: ViewStyle;
  readonly errorTitle: TextStyle;
  readonly errorSubtitle: TextStyle;
  readonly retryButton: ViewStyle;
  readonly retryButtonText: TextStyle;
  readonly summaryStats: ViewStyle;
  readonly summaryStatItem: ViewStyle;
  readonly summaryStatValue: TextStyle;
  readonly summaryStatLabel: TextStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): TasksPanelStyles {
  const padding = compact ? 10 : 12;
  const gap = compact ? 8 : 10;
  const fontSize = compact ? 12 : 13;
  const smallFontSize = compact ? 10 : 11;
  const detailFontSize = compact ? 9 : 10;

  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    header: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap,
      paddingHorizontal: padding,
      paddingVertical: padding,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    headerTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 14 : 16,
      fontWeight: "600",
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    refreshButton: {
      padding: compact ? 5 : 7,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      justifyContent: "center",
      alignItems: "center",
    },
    refreshButtonDisabled: {
      opacity: 0.5,
    },
    filterBar: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: padding,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    filterPill: {
      paddingVertical: compact ? 4 : 5,
      paddingHorizontal: compact ? 8 : 10,
      borderRadius: 999,
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    filterPillSelected: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    filterPillText: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      fontWeight: "500",
    },
    filterPillTextSelected: {
      color: theme.colors.accentForeground,
      fontWeight: "600",
    },
    scrollArea: {
      flex: 1,
    },
    scrollContent: {
      padding,
      gap,
    },
    summaryStats: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      backgroundColor: theme.colors.surface1,
      padding: compact ? 8 : 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    summaryStatItem: {
      flex: 1,
      minWidth: 70,
      alignItems: "center",
      justifyContent: "center",
    },
    summaryStatValue: {
      color: theme.colors.foreground,
      fontSize: compact ? 14 : 16,
      fontWeight: "700",
      fontVariant: ["tabular-nums"],
    },
    summaryStatLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      marginTop: 2,
    },
    agentCard: {
      backgroundColor: theme.colors.surface1,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      overflow: "hidden",
    },
    agentCardHeader: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: padding,
      paddingVertical: compact ? 8 : 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      gap: 8,
    },
    agentIdentity: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexShrink: 1,
    },
    agentTitleText: {
      color: theme.colors.foreground,
      fontSize,
      fontWeight: "600",
      flexShrink: 1,
    },
    agentMetaText: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
    },
    badgeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    statusBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    statusBadgeText: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontWeight: "500",
      textTransform: "capitalize",
    },
    countPill: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: theme.colors.surface0,
    },
    countPillText: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontWeight: "600",
      fontVariant: ["tabular-nums"],
    },
    taskList: {
      paddingHorizontal: padding,
      paddingVertical: compact ? 6 : 8,
      gap: 6,
    },
    taskRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      paddingVertical: 4,
    },
    taskOwnerLink: {
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 6,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    completedToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 4,
      marginTop: 2,
    },
    completedToggleText: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontWeight: "500",
    },
    statusIconSlot: {
      width: compact ? 16 : 18,
      height: compact ? 16 : 18,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 2,
    },
    taskBody: {
      flex: 1,
      gap: 2,
    },
    taskText: {
      color: theme.colors.foreground,
      fontSize,
      lineHeight: fontSize + 4,
    },
    taskTextCompleted: {
      color: theme.colors.foregroundMuted,
      textDecorationLine: "line-through",
    },
    activeFormText: {
      color: theme.colors.accent,
      fontSize: detailFontSize,
      fontStyle: "italic",
    },
    stateContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: compact ? 24 : 32,
      gap: 10,
    },
    stateTitle: {
      color: theme.colors.foreground,
      fontSize: compact ? 13 : 15,
      fontWeight: "600",
      textAlign: "center",
    },
    stateSubtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      textAlign: "center",
      lineHeight: smallFontSize + 5,
      maxWidth: 320,
    },
    errorContainer: {
      padding,
      margin: padding,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      gap: 8,
    },
    errorTitle: {
      color: theme.colors.statusDanger,
      fontSize,
      fontWeight: "600",
    },
    errorSubtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      lineHeight: smallFontSize + 4,
    },
    retryButton: {
      alignSelf: "flex-start",
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.accent,
    },
    retryButtonText: {
      color: theme.colors.accentForeground,
      fontSize: smallFontSize,
      fontWeight: "600",
    },
  };
}

export function WorkspaceTasksBody({
  workspaceId,
  theme,
  host,
  layout,
}: {
  workspaceId: string;
  theme: PluginTheme;
  host: PluginHostProps["host"];
  layout: PluginHostProps["layout"];
}): ReactElement {
  const {
    groups: agentGroups,
    loading,
    refreshing,
    error: errorMessage,
    refresh: handleManualRefresh,
  } = useWorkspaceTaskGroups(workspaceId);
  const [filter, setFilter] = useState<TaskStatusFilter>("all");
  const [collapsedAgents, setCollapsedAgents] = useState<ReadonlySet<string>>(new Set());
  const [expandedCompletedAgents, setExpandedCompletedAgents] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const toggleAgentCollapse = useCallback((agentId: string) => {
    setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const toggleCompletedTasks = useCallback((agentId: string) => {
    setExpandedCompletedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const handleOpenAgent = useCallback(
    (agentId: string) => {
      openAgentInPaseoWorkspace(host.id, workspaceId, agentId);
    },
    [host.id, workspaceId],
  );

  const totalWorkspaceCounts = useMemo(() => sumCounts(agentGroups), [agentGroups]);

  const filteredGroups = useMemo(() => {
    return agentGroups
      .map((group) => {
        let tasks = group.tasks;
        if (filter === "in_progress") {
          tasks = tasks.filter((t) => t.status === "in_progress");
        } else if (filter === "pending") {
          tasks = tasks.filter((t) => t.status === "pending");
        } else if (filter === "completed") {
          tasks = tasks.filter((t) => t.status === "completed");
        }
        return {
          ...group,
          tasks,
        };
      })
      .filter((group) => group.tasks.length > 0);
  }, [agentGroups, filter]);

  const refreshAccessibilityState = useMemo(() => ({ busy: refreshing }), [refreshing]);
  const allFilterAccessibilityState = useMemo(() => ({ selected: filter === "all" }), [filter]);
  const inProgressFilterAccessibilityState = useMemo(
    () => ({ selected: filter === "in_progress" }),
    [filter],
  );
  const pendingFilterAccessibilityState = useMemo(
    () => ({ selected: filter === "pending" }),
    [filter],
  );
  const completedFilterAccessibilityState = useMemo(
    () => ({ selected: filter === "completed" }),
    [filter],
  );
  const handleAllFilter = useCallback(() => setFilter("all"), []);
  const handleInProgressFilter = useCallback(() => setFilter("in_progress"), []);
  const handlePendingFilter = useCallback(() => setFilter("pending"), []);
  const handleCompletedFilter = useCallback(() => setFilter("completed"), []);
  const agentCollapseHandlers = useMemo(
    () =>
      new Map(
        agentGroups.map((group) => [group.agentId, () => toggleAgentCollapse(group.agentId)]),
      ),
    [agentGroups, toggleAgentCollapse],
  );
  const agentOpenHandlers = useMemo(
    () =>
      new Map(agentGroups.map((group) => [group.agentId, () => handleOpenAgent(group.agentId)])),
    [agentGroups, handleOpenAgent],
  );
  const agentExpandedStates = useMemo(
    () =>
      new Map(
        agentGroups.map((group) => [
          group.agentId,
          { expanded: !collapsedAgents.has(group.agentId) },
        ]),
      ),
    [agentGroups, collapsedAgents],
  );
  const completedToggleHandlers = useMemo(
    () =>
      new Map(
        agentGroups.map((group) => [
          group.agentId,
          () => toggleCompletedTasks(group.agentId),
        ]),
      ),
    [agentGroups, toggleCompletedTasks],
  );
  const completedExpandedStates = useMemo(
    () =>
      new Map(
        agentGroups.map((group) => [
          group.agentId,
          { expanded: expandedCompletedAgents.has(group.agentId) },
        ]),
      ),
    [agentGroups, expandedCompletedAgents],
  );
  const renderTaskRow = useCallback(
    (task: TaskItemViewModel, group: AgentTasksGroup): ReactElement => (
      <Pressable
        tooltip={`Open ${task.text} in ${group.agentTitle}`}
        key={task.id}
        accessibilityRole="link"
        accessibilityLabel={`Open ${task.text} in ${group.agentTitle}`}
        onPress={agentOpenHandlers.get(group.agentId)}
        style={styles.taskRow}
      >
        <View style={styles.statusIconSlot}>
          <TaskStatusIcon
            status={task.status}
            theme={theme}
            size={layout.compact ? 13 : 15}
          />
        </View>
        <View style={styles.taskBody}>
          <Text
            style={[
              styles.taskText,
              task.status === "completed" ? styles.taskTextCompleted : null,
            ]}
          >
            {task.text}
          </Text>
          {task.activeForm ? <Text style={styles.activeFormText}>{task.activeForm}</Text> : null}
        </View>
        <View style={styles.taskOwnerLink}>
          <Icon
            name="ExternalLink"
            size={layout.compact ? 11 : 12}
            color={theme.colors.foregroundMuted}
          />
        </View>
      </Pressable>
    ),
    [agentOpenHandlers, layout.compact, styles, theme],
  );
  const nativeHitSlop = layout.platform === "web" ? undefined : TOUCH_HIT_SLOP;
  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={handleManualRefresh}
        tintColor={theme.colors.accent}
        colors={[theme.colors.accent]}
      />
    ),
    [handleManualRefresh, refreshing, theme.colors.accent],
  );

  if (loading && agentGroups.length === 0) {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Super Tasks</Text>
        </View>
        <View style={styles.stateContainer}>
          <Icon name="RefreshCw" size={14} color={theme.colors.accent} />
          <Text style={styles.stateTitle}>Loading workspace tasks...</Text>
        </View>
      </View>
    );
  }

  if (errorMessage && agentGroups.length === 0) {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Super Tasks</Text>
          <View style={styles.headerActions}>
            <Pressable
              tooltip="Retry loading tasks"
              accessibilityRole="button"
              accessibilityLabel="Retry loading tasks"
              onPress={handleManualRefresh}
              style={styles.refreshButton}
              hitSlop={nativeHitSlop}
            >
              <Icon
                name="RefreshCw"
                size={layout.compact ? 13 : 15}
                color={theme.colors.foregroundMuted}
              />
            </Pressable>
          </View>
        </View>
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Error Loading Tasks</Text>
          <Text style={styles.errorSubtitle}>{errorMessage}</Text>
          <Pressable
            tooltip="Retry loading tasks"
            accessibilityRole="button"
            accessibilityLabel="Retry"
            onPress={handleManualRefresh}
            style={styles.retryButton}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Super Tasks</Text>
        <View style={styles.headerActions}>
          <Pressable
            tooltip={refreshing ? "Refreshing tasks" : "Refresh tasks"}
            accessibilityRole="button"
            accessibilityLabel={refreshing ? "Refreshing tasks" : "Refresh tasks"}
            accessibilityState={refreshAccessibilityState}
            disabled={refreshing}
            onPress={handleManualRefresh}
            style={[styles.refreshButton, refreshing ? styles.refreshButtonDisabled : null]}
            hitSlop={nativeHitSlop}
          >
            <Icon
              name="RefreshCw"
              size={layout.compact ? 13 : 15}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>

      <View style={styles.filterBar} accessibilityRole="tablist">
        <Pressable
          tooltip="Show all tasks"
          accessibilityRole="tab"
          accessibilityLabel="Show all tasks"
          accessibilityState={allFilterAccessibilityState}
          onPress={handleAllFilter}
          style={[styles.filterPill, filter === "all" ? styles.filterPillSelected : null]}
          hitSlop={nativeHitSlop}
        >
          <Text
            style={[styles.filterPillText, filter === "all" ? styles.filterPillTextSelected : null]}
          >
            All ({totalWorkspaceCounts.total})
          </Text>
        </Pressable>
        <Pressable
          tooltip="Show in-progress tasks"
          accessibilityRole="tab"
          accessibilityLabel="Show in-progress tasks"
          accessibilityState={inProgressFilterAccessibilityState}
          onPress={handleInProgressFilter}
          style={[styles.filterPill, filter === "in_progress" ? styles.filterPillSelected : null]}
          hitSlop={nativeHitSlop}
        >
          <Text
            style={[
              styles.filterPillText,
              filter === "in_progress" ? styles.filterPillTextSelected : null,
            ]}
          >
            In Progress ({totalWorkspaceCounts.inProgress})
          </Text>
        </Pressable>
        <Pressable
          tooltip="Show pending tasks"
          accessibilityRole="tab"
          accessibilityLabel="Show pending tasks"
          accessibilityState={pendingFilterAccessibilityState}
          onPress={handlePendingFilter}
          style={[styles.filterPill, filter === "pending" ? styles.filterPillSelected : null]}
          hitSlop={nativeHitSlop}
        >
          <Text
            style={[
              styles.filterPillText,
              filter === "pending" ? styles.filterPillTextSelected : null,
            ]}
          >
            Pending ({totalWorkspaceCounts.pending})
          </Text>
        </Pressable>
        <Pressable
          tooltip="Show completed tasks"
          accessibilityRole="tab"
          accessibilityLabel="Show completed tasks"
          accessibilityState={completedFilterAccessibilityState}
          onPress={handleCompletedFilter}
          style={[styles.filterPill, filter === "completed" ? styles.filterPillSelected : null]}
          hitSlop={nativeHitSlop}
        >
          <Text
            style={[
              styles.filterPillText,
              filter === "completed" ? styles.filterPillTextSelected : null,
            ]}
          >
            Done ({totalWorkspaceCounts.completed})
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={layout.platform === "web" ? undefined : refreshControl}
      >
        {totalWorkspaceCounts.total > 0 ? (
          <View style={styles.summaryStats}>
            <View style={styles.summaryStatItem}>
              <Text style={styles.summaryStatValue}>{totalWorkspaceCounts.total}</Text>
              <Text style={styles.summaryStatLabel}>Total</Text>
            </View>
            <View style={styles.summaryStatItem}>
              <Text style={[styles.summaryStatValue, { color: theme.colors.accent }]}>
                {totalWorkspaceCounts.inProgress}
              </Text>
              <Text style={styles.summaryStatLabel}>In Progress</Text>
            </View>
            <View style={styles.summaryStatItem}>
              <Text style={styles.summaryStatValue}>{totalWorkspaceCounts.pending}</Text>
              <Text style={styles.summaryStatLabel}>Pending</Text>
            </View>
            <View style={styles.summaryStatItem}>
              <Text style={[styles.summaryStatValue, { color: theme.colors.statusSuccess }]}>
                {totalWorkspaceCounts.completed}
              </Text>
              <Text style={styles.summaryStatLabel}>Done</Text>
            </View>
          </View>
        ) : null}

        {filteredGroups.length === 0 ? (
          <View style={styles.stateContainer}>
            <Icon
              name="ListTodo"
              size={layout.compact ? 28 : 36}
              color={theme.colors.foregroundMuted}
            />
            <Text style={styles.stateTitle}>
              {agentGroups.length === 0
                ? "No agents in workspace"
                : totalWorkspaceCounts.total === 0
                  ? "No task snapshots yet"
                  : `No ${filter.replace("_", " ")} tasks`}
            </Text>
            <Text style={styles.stateSubtitle}>
              {agentGroups.length === 0
                ? "Create an agent in this workspace to track automated todo progress."
                : totalWorkspaceCounts.total === 0
                  ? "Agents will report structured todo items as they progress."
                  : "Try selecting a different filter above to view other tasks."}
            </Text>
          </View>
        ) : (
          filteredGroups.map((group) => {
            const isCollapsed = collapsedAgents.has(group.agentId);
            const isCompletedExpanded = expandedCompletedAgents.has(group.agentId);
            const completedTasks =
              filter === "completed"
                ? []
                : group.tasks.filter((task) => task.status === "completed");
            const activeTasks =
              filter === "completed"
                ? group.tasks
                : group.tasks.filter((task) => task.status !== "completed");
            return (
              <View key={group.agentId} style={styles.agentCard}>
                <Pressable
                  tooltip={`${isCollapsed ? "Expand" : "Collapse"} ${group.agentTitle} tasks`}
                  accessibilityRole="button"
                  accessibilityLabel={`${group.agentTitle}, ${group.counts.completed} of ${group.counts.total} completed. Click to ${isCollapsed ? "expand" : "collapse"}`}
                  accessibilityState={agentExpandedStates.get(group.agentId)}
                  onPress={agentCollapseHandlers.get(group.agentId)}
                  style={styles.agentCardHeader}
                >
                  <View style={styles.agentIdentity}>
                    <Icon
                      name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                      size={layout.compact ? 13 : 15}
                      color={theme.colors.foregroundMuted}
                    />
                    <Icon name="Bot" size={layout.compact ? 14 : 16} color={theme.colors.accent} />
                    <View style={AGENT_TITLE_COLUMN_STYLE}>
                      <Text style={styles.agentTitleText} numberOfLines={1}>
                        {group.agentTitle}
                      </Text>
                      <Text style={styles.agentMetaText}>
                        {group.isMain ? "Main agent" : "Subagent"} · {group.provider} ·{" "}
                        {group.counts.completed}/{group.counts.total} done
                      </Text>
                    </View>
                  </View>

                  <View style={styles.badgeRow}>
                    <View style={styles.statusBadge}>
                      <Text style={styles.statusBadgeText}>{group.status}</Text>
                    </View>
                    {group.counts.inProgress > 0 ? (
                      <View style={[styles.countPill, { backgroundColor: theme.colors.surface2 }]}>
                        <Text style={[styles.countPillText, { color: theme.colors.accent }]}>
                          {group.counts.inProgress} active
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </Pressable>

                {!isCollapsed && group.tasks.length > 0 ? (
                  <View style={styles.taskList}>
                    {activeTasks.map((task) => renderTaskRow(task, group))}
                    {completedTasks.length > 0 ? (
                      <Pressable
                        tooltip={
                          isCompletedExpanded
                            ? `Hide ${completedTasks.length} completed tasks`
                            : `Show ${completedTasks.length} completed tasks`
                        }
                        accessibilityRole="button"
                        accessibilityLabel={
                          isCompletedExpanded
                            ? `Hide ${completedTasks.length} completed tasks`
                            : `Show ${completedTasks.length} completed tasks`
                        }
                        accessibilityState={completedExpandedStates.get(group.agentId)}
                        onPress={completedToggleHandlers.get(group.agentId)}
                        style={styles.completedToggle}
                      >
                        <Icon
                          name={isCompletedExpanded ? "ChevronDown" : "ChevronRight"}
                          size={layout.compact ? 12 : 14}
                          color={theme.colors.foregroundMuted}
                        />
                        <Text style={styles.completedToggleText}>
                          Done ({completedTasks.length})
                        </Text>
                      </Pressable>
                    ) : null}
                    {isCompletedExpanded
                      ? completedTasks.map((task) => renderTaskRow(task, group))
                      : null}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

export function WorkspaceTasksPanel(props: PluginWorkspacePanelProps): ReactElement {
  return (
    <WorkspaceTasksBody
      workspaceId={props.workspaceId}
      theme={props.theme}
      host={props.host}
      layout={props.layout}
    />
  );
}

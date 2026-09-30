import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginClientContext,
  PluginPopoverProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { openAgentInPaseoWorkspace } from "../agents/navigation";
import {
  findActiveTaskLabel,
  sumCounts,
  type AgentTasksGroup,
  type TaskItemViewModel,
} from "./model";
import { TaskStatusIcon } from "./status-icon";
import { useMostRecentWorkspaceId, useWorkspaceTaskGroups } from "./use-workspace-task-groups";

type OpenPanel = PluginClientContext["openPanel"];

interface SuperTasksSidebarItemProps extends PluginSidebarItemProps {
  openPanel: OpenPanel;
}

interface SuperTasksPopoverProps extends PluginPopoverProps {
  openPanel: OpenPanel;
}

interface SidebarStyles {
  readonly trailing: ViewStyle;
  readonly trailingCount: TextStyle;
  readonly trailingActive: TextStyle;
  readonly popover: ViewStyle;
  readonly summary: ViewStyle;
  readonly summaryText: TextStyle;
  readonly summaryMeta: TextStyle;
  readonly group: ViewStyle;
  readonly groupHeader: ViewStyle;
  readonly groupTitle: TextStyle;
  readonly groupMeta: TextStyle;
  readonly taskRow: ViewStyle;
  readonly taskIcon: ViewStyle;
  readonly taskBody: ViewStyle;
  readonly taskText: TextStyle;
  readonly taskTextCompleted: TextStyle;
  readonly taskActive: TextStyle;
  readonly doneToggle: ViewStyle;
  readonly doneToggleText: TextStyle;
  readonly empty: TextStyle;
  readonly footerButton: ViewStyle;
  readonly footerButtonText: TextStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): SidebarStyles {
  const fontSize = compact ? 12 : 13;
  const smallFontSize = compact ? 10 : 11;
  const detailFontSize = compact ? 9 : 10;
  return {
    trailing: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
      justifyContent: "flex-end",
    },
    trailingCount: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontVariant: ["tabular-nums"],
    },
    trailingActive: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      flexShrink: 1,
      maxWidth: 160,
    },
    popover: {
      gap: 8,
    },
    summary: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    summaryText: {
      color: theme.colors.foreground,
      fontSize,
      fontWeight: "600",
    },
    summaryMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      fontVariant: ["tabular-nums"],
    },
    group: {
      gap: 2,
      paddingTop: 6,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      marginBottom: 2,
    },
    groupTitle: {
      color: theme.colors.foreground,
      fontSize: smallFontSize,
      fontWeight: "600",
      flexShrink: 1,
    },
    groupMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontVariant: ["tabular-nums"],
    },
    taskRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      paddingVertical: 2,
    },
    taskIcon: {
      width: compact ? 14 : 16,
      alignItems: "center",
      marginTop: 2,
    },
    taskBody: {
      flex: 1,
      gap: 1,
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
    taskActive: {
      color: theme.colors.accent,
      fontSize: detailFontSize,
      fontStyle: "italic",
    },
    doneToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingVertical: 3,
      marginTop: 2,
    },
    doneToggleText: {
      color: theme.colors.foregroundMuted,
      fontSize: detailFontSize,
      fontWeight: "500",
    },
    empty: {
      color: theme.colors.foregroundMuted,
      fontSize: smallFontSize,
      lineHeight: smallFontSize + 4,
    },
    footerButton: {
      marginTop: 4,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
      alignItems: "center",
    },
    footerButtonText: {
      color: theme.colors.foreground,
      fontSize: smallFontSize,
      fontWeight: "600",
    },
  };
}

/**
 * The sidebar footer's Super Tasks entry: the most recently active workspace's progress, opening a
 * popover with the full list. Sidebar items are host-wide, so the workspace is inferred.
 */
export function SuperTasksSidebarItem({
  theme,
  layout,
  openPopover,
  openPanel,
}: SuperTasksSidebarItemProps): ReactElement {
  const workspaceId = useMostRecentWorkspaceId();
  const { groups } = useWorkspaceTaskGroups(workspaceId);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const totals = useMemo(() => sumCounts(groups), [groups]);
  const activeLabel = useMemo(() => findActiveTaskLabel(groups), [groups]);

  const trailing = useMemo(() => {
    if (totals.total === 0) return null;
    return (
      <View style={styles.trailing}>
        <Text style={styles.trailingCount}>
          {totals.completed}/{totals.total}
        </Text>
        {activeLabel ? (
          <Text style={styles.trailingActive} numberOfLines={1}>
            {activeLabel}
          </Text>
        ) : null}
      </View>
    );
  }, [activeLabel, styles, totals.completed, totals.total]);

  const PopoverContent = useCallback(
    (props: PluginPopoverProps) => <SuperTasksPopover {...props} openPanel={openPanel} />,
    [openPanel],
  );
  const handlePress = useCallback(() => {
    openPopover(PopoverContent);
  }, [openPopover, PopoverContent]);

  return <SidebarRow icon="ListChecks" onPress={handlePress} trailing={trailing} />;
}

function SuperTasksPopover({
  theme,
  layout,
  host,
  close,
  openPanel,
}: SuperTasksPopoverProps): ReactElement {
  const workspaceId = useMostRecentWorkspaceId();
  const { groups, loading, error } = useWorkspaceTaskGroups(workspaceId);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const totals = useMemo(() => sumCounts(groups), [groups]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const compact = layout.compact;

  const openAgent = useCallback(
    (agentId: string) => {
      close();
      if (workspaceId) openAgentInPaseoWorkspace(host.id, workspaceId, agentId);
    },
    [close, host.id, workspaceId],
  );
  const openFullPanel = useCallback(() => {
    if (workspaceId) {
      try {
        openPanel("tasks", { workspaceId });
      } catch {
        // The panel is unavailable on this host; leave the popover open.
        return;
      }
    }
    close();
  }, [close, openPanel, workspaceId]);

  const openHandlers = useMemo(
    () => new Map(groups.map((group) => [group.agentId, () => openAgent(group.agentId)])),
    [groups, openAgent],
  );
  const toggleHandlers = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.agentId,
          () =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(group.agentId)) next.delete(group.agentId);
              else next.add(group.agentId);
              return next;
            }),
        ]),
      ),
    [groups],
  );

  const renderTask = useCallback(
    (group: AgentTasksGroup, task: TaskItemViewModel): ReactElement => (
      <Pressable
        key={task.id}
        accessibilityRole="link"
        accessibilityLabel={`Open ${task.text} in ${group.agentTitle}`}
        onPress={openHandlers.get(group.agentId)}
        style={styles.taskRow}
      >
        <View style={styles.taskIcon}>
          <TaskStatusIcon status={task.status} theme={theme} size={compact ? 12 : 13} />
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
          {task.activeForm ? <Text style={styles.taskActive}>{task.activeForm}</Text> : null}
        </View>
      </Pressable>
    ),
    [compact, openHandlers, styles, theme],
  );

  if (loading && groups.length === 0) {
    return <Text style={styles.empty}>Loading tasks...</Text>;
  }
  if (error && groups.length === 0) {
    return <Text style={styles.empty}>{error}</Text>;
  }
  if (totals.total === 0) {
    return <Text style={styles.empty}>No task snapshots yet.</Text>;
  }

  return (
    <View style={styles.popover}>
      <View style={styles.summary}>
        <Text style={styles.summaryText}>Super Tasks</Text>
        <Text style={styles.summaryMeta}>
          {totals.completed}/{totals.total} done
        </Text>
      </View>
      {groups
        .filter((group) => group.tasks.length > 0)
        .map((group) => {
          const isExpanded = expanded.has(group.agentId);
          const completed = group.tasks.filter((task) => task.status === "completed");
          const active = group.tasks.filter((task) => task.status !== "completed");
          return (
            <View key={group.agentId} style={styles.group}>
              <View style={styles.groupHeader}>
                <Text style={styles.groupTitle} numberOfLines={1}>
                  {group.agentTitle}
                </Text>
                <Text style={styles.groupMeta}>
                  {group.counts.completed}/{group.counts.total} done
                </Text>
              </View>
              {active.map((task) => renderTask(group, task))}
              {completed.length > 0 ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      isExpanded
                        ? `Hide ${completed.length} completed tasks`
                        : `Show ${completed.length} completed tasks`
                    }
                    onPress={toggleHandlers.get(group.agentId)}
                    style={styles.doneToggle}
                  >
                    <Icon
                      name={isExpanded ? "ChevronDown" : "ChevronRight"}
                      size={compact ? 11 : 12}
                      color={theme.colors.foregroundMuted}
                    />
                    <Text style={styles.doneToggleText}>Done ({completed.length})</Text>
                  </Pressable>
                  {isExpanded ? completed.map((task) => renderTask(group, task)) : null}
                </>
              ) : null}
            </View>
          );
        })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open Super Tasks in workspace"
        onPress={openFullPanel}
        style={styles.footerButton}
      >
        <Text style={styles.footerButtonText}>Open in workspace</Text>
      </Pressable>
    </View>
  );
}

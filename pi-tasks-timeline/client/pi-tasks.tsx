import type {
  PluginAgentPanelProps,
  PluginButtonContentProps,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { activeTasks, usePiTaskSnapshot } from "./pi-tasks-state";
import { piTaskListSchema } from "../shared/pi-tasks";

type TaskListData = z.output<typeof piTaskListSchema>;
type PiTask = TaskListData["tasks"][number];

const taskMarker = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
} as const;

function taskKey(task: PiTask): string {
  return task.id ?? task.text;
}

function useTaskStyles(theme: PluginAgentPanelProps["theme"], compact: boolean) {
  return useMemo(
    () => ({
      card: {
        gap: compact ? 6 : 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 12,
        backgroundColor: theme.colors.surface1,
      },
      header: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      progress: { color: theme.colors.foregroundMuted },
      task: { flexDirection: "row" as const, gap: 8 },
      completed: { color: theme.colors.statusSuccess },
      inProgress: { color: theme.colors.accent },
      pending: { color: theme.colors.foregroundMuted },
      taskText: { color: theme.colors.foreground, flex: 1 },
      completedText: { color: theme.colors.foregroundMuted, flex: 1 },
      activeForm: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [compact, theme],
  );
}

function TaskRows({
  tasks,
  theme,
  compact,
  progressLabel,
}: {
  tasks: readonly PiTask[];
  theme: PluginAgentPanelProps["theme"];
  compact: boolean;
  progressLabel?: string;
}) {
  const styles = useTaskStyles(theme, compact);
  const completed = tasks.filter((task) => task.status === "completed").length;
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Pi tasks</Text>
        <Text style={styles.progress}>{progressLabel ?? `${completed}/${tasks.length}`}</Text>
      </View>
      {tasks.map((task) => {
        let markerStyle = styles.pending;
        if (task.status === "completed") markerStyle = styles.completed;
        if (task.status === "in_progress") markerStyle = styles.inProgress;
        return (
          <View key={taskKey(task)} style={styles.task}>
            <Text style={markerStyle}>{taskMarker[task.status]}</Text>
            <View style={{ flex: 1 }}>
              <Text style={task.status === "completed" ? styles.completedText : styles.taskText}>
                {task.text}
              </Text>
              {task.status === "in_progress" && task.activeForm ? (
                <Text style={styles.activeForm}>{task.activeForm}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function PiTaskList({
  item,
  theme,
  layout,
}: PluginTimelineItemProps<TaskListData>) {
  return <TaskRows tasks={item.data.tasks} theme={theme} compact={layout.compact} />;
}

export function PiTasksPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const snapshot = usePiTaskSnapshot(agentId);
  const tasks = snapshot.tasks ?? [];
  const visibleTasks = activeTasks(tasks);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [layout.compact, theme],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Active Pi tasks</Text>
      {snapshot.loading && snapshot.tasks === null ? <Text style={styles.detail}>Loading tasks…</Text> : null}
      {snapshot.error ? <Text style={styles.error}>Unable to load tasks: {snapshot.error}</Text> : null}
      {!snapshot.loading && !snapshot.error && visibleTasks.length === 0 ? (
        <Text style={styles.detail}>No active tasks.</Text>
      ) : null}
      {visibleTasks.length > 0 ? (
        <TaskRows
          tasks={visibleTasks}
          theme={theme}
          compact={layout.compact}
          progressLabel={`${visibleTasks.length} active`}
        />
      ) : null}
    </View>
  );
}

export function PiTasksPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = "agentId" in props ? props.agentId : "";
  const snapshot = usePiTaskSnapshot(agentId);
  const tasks = activeTasks(snapshot.tasks);
  const styles = useMemo(
    () => ({
      content: { gap: 12 },
      detail: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );
  return (
    <View style={styles.content}>
      {snapshot.loading && snapshot.tasks === null ? (
        <Text style={styles.detail}>Loading tasks…</Text>
      ) : null}
      {snapshot.error ? <Text style={styles.error}>Unable to load tasks: {snapshot.error}</Text> : null}
      {!snapshot.loading && !snapshot.error && tasks.length === 0 ? (
        <Text style={styles.detail}>No active tasks.</Text>
      ) : null}
      {tasks.length > 0 ? (
        <TaskRows tasks={tasks} theme={theme} compact={layout.compact} progressLabel={`${tasks.length} active`} />
      ) : null}
    </View>
  );
}

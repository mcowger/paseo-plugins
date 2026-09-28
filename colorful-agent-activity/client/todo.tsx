import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { PaseoHero, Section } from "./paseo";
import {
  parseTodoToolInput,
  parseTodoToolOutput,
  todoToolActionLabel,
  type ActivityPalette,
  type TodoToolStatus,
  type TodoToolTask,
} from "../shared/presentation";

type Theme = PluginTimelineItemProps["theme"];

type DetailProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
};

const STATUS_ICONS: Record<TodoToolStatus, string> = {
  completed: "CircleCheck",
  in_progress: "LoaderCircle",
  pending: "Circle",
};

function TodoTaskRow({
  task,
  theme,
  palette,
  styles,
}: {
  task: TodoToolTask;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const color =
    task.status === "completed"
      ? palette.statusColors.completed
      : task.status === "in_progress"
        ? palette.statusColors.running
        : theme.colors.foregroundMuted;
  const meta = [
    task.status === "in_progress" ? task.activeForm : undefined,
    task.blockedBy.length > 0 ? `blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.paseoListItem}>
      <View style={styles.paseoListItemHeader}>
        <Icon name={STATUS_ICONS[task.status]} color={color} size={11} />
        <Text
          numberOfLines={1}
          selectable
          style={task.status === "completed" ? styles.todoDone : styles.paseoListItemTitle}
        >
          {`#${task.id} ${task.subject}`}
        </Text>
      </View>
      {meta ? (
        <Text numberOfLines={1} style={styles.paseoListItemMeta}>
          {meta}
        </Text>
      ) : null}
      {task.status === "in_progress" && task.description ? (
        <Text numberOfLines={2} style={styles.paseoListItemMeta}>
          {task.description}
        </Text>
      ) : null}
    </View>
  );
}

export function TodoToolDetail({ input, output, theme, palette, styles }: DetailProps) {
  const parsedInput = parseTodoToolInput(input);
  const summary = parseTodoToolOutput(output);
  const tasks = summary?.tasks ?? [];
  const done = tasks.filter((task) => task.status === "completed").length;
  const focusId = summary?.task?.id ?? parsedInput.id;
  const focusTask =
    focusId !== undefined ? tasks.find((task) => task.id === focusId) ?? summary?.task : summary?.task;
  const subtitle = [
    tasks.length > 0 ? `${done}/${tasks.length} done` : undefined,
    focusTask ? `#${focusTask.id} ${focusTask.activeForm ?? focusTask.subject}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.paseoStack}>
      <PaseoHero
        icon="ListChecks"
        title={todoToolActionLabel(summary?.action ?? parsedInput.action)}
        subtitle={subtitle || undefined}
        palette={palette}
        color={palette.categoryColors.plan}
        styles={styles}
      />
      {summary?.text ? (
        <Section title="Result" styles={styles}>
          <Text selectable style={styles.detailText}>
            {summary.text.trim()}
          </Text>
        </Section>
      ) : null}
      {tasks.length > 0 ? (
        <Section title={`Tasks (${tasks.length})`} styles={styles}>
          <View style={styles.paseoList}>
            {tasks.map((task) => (
              <TodoTaskRow key={task.id} task={task} theme={theme} palette={palette} styles={styles} />
            ))}
          </View>
        </Section>
      ) : null}
    </View>
  );
}

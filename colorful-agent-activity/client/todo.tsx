import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { Section } from "./paseo";
import {
  todoTaskLabel,
  todoToolDetailModel,
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
  showDescription,
}: {
  task: TodoToolTask;
  showDescription: boolean;
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
          {todoTaskLabel(task.id, task.subject)}
        </Text>
      </View>
      {meta ? (
        <Text numberOfLines={1} style={styles.paseoListItemMeta}>
          {meta}
        </Text>
      ) : null}
      {showDescription && task.description ? (
        <Text numberOfLines={2} style={styles.paseoListItemMeta}>
          {task.description}
        </Text>
      ) : null}
    </View>
  );
}

export function TodoToolDetail({ input, output, theme, palette, styles }: DetailProps) {
  const model = todoToolDetailModel(input, output);
  if (!model.resultText && model.tasks.length === 0) return null;

  return (
    <View style={styles.paseoStack}>
      {model.resultText ? (
        <Text selectable style={styles.detailText}>
          {model.resultText}
        </Text>
      ) : null}
      {model.tasks.length > 1 ? (
        <Section title={`Tasks (${model.tasks.length})`} styles={styles}>
          <View style={styles.paseoList}>
            {model.tasks.map((task) => (
              <TodoTaskRow
                key={task.id}
                task={task}
                showDescription={task.status === "in_progress"}
                theme={theme} palette={palette} styles={styles} />
            ))}
          </View>
        </Section>
      ) : model.tasks[0] ? (
        <TodoTaskRow task={model.tasks[0]} showDescription theme={theme} palette={palette} styles={styles} />
      ) : null}
    </View>
  );
}

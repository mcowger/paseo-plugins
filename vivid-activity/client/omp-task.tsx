import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { formatUnknownValue, type ActivityPalette } from "../shared/presentation";
import { parseOmpTaskInput, parseOmpTaskOutput } from "../shared/omp-task";
 

type Theme = PluginTimelineItemProps["theme"];
type DetailProps = {
  input: unknown;
  output: unknown;
  errorText?: string;
  status: string;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
};

const STATUS_LABELS: Record<string, string> = {
  get running() { return t("ui.running"); },
  get completed() { return t("ui.completed"); },
  get done() { return t("ui.completed"); },
  get failed() { return t("ui.failed"); },
  get error() { return t("ui.failed"); },
  get canceled() { return t("ui.canceled"); },
  get cancelled() { return t("ui.canceled"); },
};

function statusLabel(status: string | undefined): string {
  if (!status) return t("ui.waiting");
  return STATUS_LABELS[status] ?? status;
}

export function OmpTaskToolDetail({ input, output, errorText, status, styles }: DetailProps) {
  const batch = parseOmpTaskOutput(output);
  const tasks = batch?.tasks.length ? batch.tasks : parseOmpTaskInput(input);
  const inputText = tasks.length ? undefined : formatUnknownValue(input);
  const rawOutput = batch?.text || (output == null ? "" : formatUnknownValue(output));
  return (
    <View style={styles.section}>
      {tasks.map((task, index) => (
        <View key={`${task.id ?? index}`} style={styles.section}>
          <Text selectable style={styles.detailText}>{task.description ?? task.id ?? t("ui.step", { number: index + 1 })}</Text>
          <Text selectable style={styles.mutedText}>{[statusLabel(task.status), task.id].filter(Boolean).join(t("ui.metaSeparator"))}</Text>
          {task.result ? <Text selectable style={styles.detailText}>{task.result}</Text> : null}
        </View>
      ))}
      {errorText ? <Text selectable style={styles.detailText}>{errorText}</Text> : null}
      {!tasks.length && inputText ? <Text selectable style={styles.detailText}>{inputText}</Text> : null}
      {rawOutput ? <Text selectable style={styles.detailText}>{rawOutput}</Text> : null}
      {!tasks.length && !inputText && !rawOutput && !errorText && status !== "running" ? (
        <Text style={styles.empty}>{t("ui.noToolDetails")}</Text>
      ) : null}
    </View>
  );
}

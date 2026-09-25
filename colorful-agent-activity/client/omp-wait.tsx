import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { View } from "react-native";
import type { ActivityStyles } from "./activity";
import { PaseoFields, PaseoHero, Section } from "./paseo";
import {
  formatWaitTimeout,
  ompWaitLabel,
  parseOmpWaitOutput,
  type ActivityPalette,
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

const JOB_STATUS_LABELS: Record<string, string> = {
  running: "Running",
  completed: "Completed",
  done: "Completed",
  failed: "Failed",
  error: "Failed",
  canceled: "Canceled",
  cancelled: "Canceled",
};

function displayStatus(status: string | undefined): string {
  if (!status) return "Waiting";
  return JOB_STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export function OmpWaitToolDetail({ output, palette, styles }: DetailProps) {
  const jobs = parseOmpWaitOutput(output)?.jobs ?? [];
  const durations = jobs.flatMap((job) => (job.durationMs !== undefined ? [job.durationMs] : []));
  const longest = durations.length > 0 ? formatWaitTimeout(Math.max(...durations)) : undefined;
  const subtitle =
    jobs.length > 0
      ? [`${jobs.length} agent${jobs.length === 1 ? "" : "s"}`, longest].filter(Boolean).join(" · ")
      : undefined;
  const status = jobs.some((job) => job.status === "failed" || job.status === "error")
    ? "Attention"
    : jobs.length > 0 && jobs.every((job) => job.status === "completed" || job.status === "done")
      ? "Completed"
      : jobs.some((job) => job.status === "running")
        ? "Waiting"
        : undefined;

  return (
    <View style={styles.paseoStack}>
      <PaseoHero
        icon="Hourglass"
        title={ompWaitLabel(output)}
        subtitle={subtitle || undefined}
        status={status}
        palette={palette}
        color={palette.categoryColors.agent}
        styles={styles}
      />
      {jobs.length > 0 ? (
        <Section title={`Agents (${jobs.length})`} styles={styles}>
          <PaseoFields
            fields={jobs.map((job) => [
              job.label ?? job.id,
              [
                displayStatus(job.status),
                job.durationMs !== undefined ? formatWaitTimeout(job.durationMs) : undefined,
                job.model,
              ]
                .filter(Boolean)
                .join(" · "),
            ])}
            palette={palette}
            styles={styles}
          />
        </Section>
      ) : null}
    </View>
  );
}

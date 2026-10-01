import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { View } from "react-native";
import type { ActivityStyles } from "./activity";
import { PaseoFields, Section } from "./paseo";
import {
  formatWaitTimeout,
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

  return (
    <View style={styles.paseoStack}>
      {jobs.length > 0 ? (
        <Section title="Agents" styles={styles}>
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

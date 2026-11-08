import { t } from "../shared/text";
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
  get running() { return t("ui.running"); },
  get completed() { return t("ui.completed"); },
  get done() { return t("ui.completed"); },
  get failed() { return t("ui.failed"); },
  get error() { return t("ui.failed"); },
  get canceled() { return t("ui.canceled"); },
  get cancelled() { return t("ui.canceled"); },
};

function displayStatus(status: string | undefined): string {
  if (!status) return t("ui.waiting");
  return JOB_STATUS_LABELS[status] ?? status;
}

export function OmpWaitToolDetail({ output, palette, styles }: DetailProps) {
  const jobs = parseOmpWaitOutput(output)?.jobs ?? [];

  return (
    <View style={styles.paseoStack}>
      {jobs.length > 0 ? (
        <Section title={t("ui.agent")} styles={styles}>
          <PaseoFields
            fields={jobs.map((job) => [
              job.label ?? job.id,
              [
                displayStatus(job.status),
                job.durationMs !== undefined ? formatWaitTimeout(job.durationMs) : undefined,
                job.model,
              ]
                .filter(Boolean)
                .join(t("ui.metaSeparator")),
            ])}
            palette={palette}
            styles={styles}
          />
        </Section>
      ) : null}
    </View>
  );
}

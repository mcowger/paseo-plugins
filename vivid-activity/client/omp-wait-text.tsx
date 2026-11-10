import { t } from "../shared/text";
import type { OmpWaitTextModel } from "../shared/omp-wait-text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import type { ActivityPalette } from "../shared/presentation";
import { ReasoningMarkdown } from "./activity-details";
import { PaseoFields, Section } from "./paseo";

type Theme = PluginTimelineItemProps["theme"];
type WaitTextModel = OmpWaitTextModel;

type Props = {
  model: WaitTextModel;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
};

export function OmpWaitTextDetail({ model, theme, palette, styles }: Props) {
  return (
    <View style={styles.paseoStack}>
      {model.kind === "result" ? (
        model.entries.map((entry) => (
          <View key={entry.id} style={styles.paseoStack}>
            <Section title={entry.id || t("ui.result")} styles={styles}>
              <PaseoFields
                fields={[
                  ...(entry.agent ? [[t("ui.agent"), entry.agent] as [string, string]] : []),
                  ...(entry.status ? [[t("ui.status"), entry.status] as [string, string]] : []),
                  ...(entry.duration ? [[t("ui.duration"), entry.duration] as [string, string]] : []),
                  ...(entry.metadata ?? []).map((value, metadataIndex) => [String(metadataIndex + 1), value] as [string, string]),
                ]}
                palette={palette}
                styles={styles}
              />
              {entry.output ? <ReasoningMarkdown text={entry.output} theme={theme} styles={styles} /> : null}
            </Section>
          </View>
        ))
      ) : (
        <Section title={t("ui.running")} styles={styles}>
          <PaseoFields
            fields={model.entries.map((entry) => [
              entry.id,
              [entry.agent, entry.status, entry.duration, ...(entry.metadata ?? [])].filter(Boolean).join(t("ui.metaSeparator")),
            ])}
            palette={palette}
            styles={styles}
          />
        </Section>
      )}
      {model.remainder ? <Text selectable style={styles.detailText}>{model.remainder}</Text> : null}
    </View>
  );
}

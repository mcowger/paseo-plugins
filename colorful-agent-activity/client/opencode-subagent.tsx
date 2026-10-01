import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { FieldsSection, PaseoCodeBlock, Section } from "./paseo";
import {
  notInHeader,
  opencodeSubagentSummary,
  parseOpencodeSubagentInput,
  parseOpencodeSubagentOutput,
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

export function OpencodeSubagentToolDetail({ input, output, theme, palette, styles }: DetailProps) {
  const parsedInput = parseOpencodeSubagentInput(input);
  const parsedOutput = parseOpencodeSubagentOutput(output);
  const summary = opencodeSubagentSummary(input, output);
  const status = parsedOutput?.status;
  const sessionID = parsedOutput?.sessionID ?? parsedInput.sessionID;
  const resultText = parsedOutput?.text;

  return (
    <View style={styles.paseoStack}>
      <FieldsSection
        title="Task"
        fields={[
          ["Agent", notInHeader(parsedInput.agent, summary)],
          ["Description", notInHeader(parsedInput.description, summary)],
          ["Model", parsedInput.model],
          ["Status", status],
          ["Session", sessionID],
          ["Continue", parsedInput.sessionID && parsedInput.sessionID !== sessionID ? parsedInput.sessionID : undefined],
          ["Background", parsedInput.background],
        ]}
        palette={palette}
        styles={styles}
      />
      {parsedInput.prompt ? (
        <PaseoCodeBlock
          code={parsedInput.prompt}
          language="text"
          label="Prompt"
          theme={theme}
          styles={styles}
        />
      ) : null}
      {resultText && !parsedOutput?.isBackgroundNotice ? (
        <Section title="Result" styles={styles}>
          <Text selectable style={styles.detailText}>
            {resultText}
          </Text>
        </Section>
      ) : resultText ? (
        <Section title="Status" styles={styles}>
          <Text selectable style={styles.mutedText}>
            {resultText}
          </Text>
        </Section>
      ) : null}
    </View>
  );
}

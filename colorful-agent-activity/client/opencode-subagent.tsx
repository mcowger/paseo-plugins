import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { PaseoCodeBlock, PaseoFields, PaseoHero, Section, StatusPill } from "./paseo";
import {
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
  const title = parsedInput.description ?? parsedInput.agent ?? "Agent Task";
  const subtitleParts: string[] = [];
  if (parsedInput.agent && parsedInput.description) subtitleParts.push(parsedInput.agent);
  if (parsedInput.model) subtitleParts.push(parsedInput.model);
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(" · ") : undefined;
  const status = parsedOutput?.status;
  const sessionID = parsedOutput?.sessionID ?? parsedInput.sessionID;
  const resultText = parsedOutput?.text;

  return (
    <View style={styles.paseoStack}>
      <PaseoHero
        icon="Bot"
        title={title}
        subtitle={subtitle}
        status={status}
        palette={palette}
        color={palette.categoryColors.agent}
        styles={styles}
      />
      {status ? <StatusPill value={status} palette={palette} styles={styles} /> : null}
      <Section title="Task" styles={styles}>
        <PaseoFields
          fields={[
            ["Agent", parsedInput.agent],
            ["Description", parsedInput.description],
            ["Model", parsedInput.model],
            ["Session", sessionID],
            ["Continue", parsedInput.sessionID && parsedInput.sessionID !== sessionID ? parsedInput.sessionID : undefined],
            ["Background", parsedInput.background],
          ]}
          palette={palette}
          styles={styles}
        />
      </Section>
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

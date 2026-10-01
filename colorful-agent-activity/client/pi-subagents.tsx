import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { FieldsSection, PaseoCodeBlock, Section, StatusPill } from "./paseo";
import {
  bgWaitSummary,
  extractPiToolText,
  formatWaitTimeout,
  notInHeader,
  parseBgWaitInput,
  parseBgWaitOutput,
  parseSubagentSupervisorInput,
  subagentSupervisorSummary,
  textAfterHeader,
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

function MessageBlock({ label, text, styles }: { label: string; text: string; styles: ActivityStyles }) {
  return (
    <Section title={label} styles={styles}>
      <Text selectable style={styles.paseoPrompt}>
        {text}
      </Text>
    </Section>
  );
}

export function SupervisorToolDetail({ input, output, palette, styles }: DetailProps) {
  const parsed = parseSubagentSupervisorInput(input);
  const envelope = extractPiToolText(output);
  const details = envelope?.details ?? {};
  const agent = typeof details.agent === "string" && details.agent.trim() ? details.agent : undefined;
  const runId = typeof details.runId === "string" && details.runId.trim() ? details.runId : undefined;
  const replyTo = parsed.replyTo ?? (typeof details.replyTo === "string" ? details.replyTo : undefined);
  const headerSummary = subagentSupervisorSummary(input, output);
  const knownAction = ["reply", "pending", "list", "status"].includes(parsed.action);
  const resultText = textAfterHeader(envelope?.text, headerSummary);
  const message = notInHeader(parsed.message, headerSummary);

  return (
    <View style={styles.paseoStack}>
      {parsed.action === "reply" ? (
        <>
          {message ? <MessageBlock label="Reply message" text={message} styles={styles} /> : null}
          <FieldsSection
            title="Request"
            fields={[
              ["Request ID", replyTo],
              ["Run", runId],
              ["Agent", notInHeader(agent, headerSummary)],
              ["Confirmation", envelope?.text || undefined],
            ]}
            palette={palette}
            styles={styles}
          />
        </>
      ) : (
        <>
          <FieldsSection
            title="Query"
            fields={[
              ["Action", knownAction ? undefined : parsed.action || undefined],
              ["To", notInHeader(parsed.to, headerSummary)],
              ["Message", message],
            ]}
            palette={palette}
            styles={styles}
          />
          {resultText ? (
            <MessageBlock label="Result" text={resultText} styles={styles} />
          ) : envelope?.text ? null : (
            <Text style={styles.empty}>No pending supervisor requests returned.</Text>
          )}
        </>
      )}
    </View>
  );
}

export function BgWaitToolDetail({ input, output, theme, palette, styles }: DetailProps) {
  const parsed = parseBgWaitInput(input);
  const summary = parseBgWaitOutput(output);
  const headerSummary = bgWaitSummary(input, output);
  const timeout = formatWaitTimeout(parsed.timeoutMs);

  return (
    <View style={styles.paseoStack}>
      {summary?.headline ? (
        <Section title="Summary" styles={styles}>
          <Text selectable style={styles.detailText}>
            {summary.headline}
          </Text>
        </Section>
      ) : null}
      <FieldsSection
        title="Wait"
        fields={[
          ["Run", parsed.id],
          ["Timeout", notInHeader(timeout ? `${timeout} timeout` : undefined, headerSummary)],
          ["Non-blocking", parsed.nonBlocking],
          ["Stop on attention", parsed.stopOnAttention],
          ["Active runs", summary && summary.activeRunIds.length > 0 ? summary.activeRunIds.join(", ") : undefined],
          [
            "Provider items",
            summary && summary.activeProviderItems.length > 0
              ? summary.activeProviderItems.map((item) => `${item.provider}:${item.id}`).join(", ")
              : undefined,
          ],
        ]}
        palette={palette}
        styles={styles}
      />
      {summary && summary.completions.length > 0 ? (
        <Section title={`Completions (${summary.completions.length})`} styles={styles}>
          <View style={styles.paseoList}>
            {summary.completions.map((completion) => (
              <View key={`completion-${completion.runId}-${completion.agent ?? "run"}`} style={styles.paseoListItem}>
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {completion.agent ?? "Run finished"}
                  </Text>
                  {completion.success !== undefined ? (
                    <StatusPill
                      value={completion.success ? "Success" : "Failed"}
                      palette={palette}
                      styles={styles}
                    />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                  {completion.runId}
                </Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
      {summary?.body ? (
        <PaseoCodeBlock code={summary.body} language="text" label="Wait log" theme={theme} styles={styles} />
      ) : null}
    </View>
  );
}

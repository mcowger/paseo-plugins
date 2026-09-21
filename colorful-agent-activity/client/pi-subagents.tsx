import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { PaseoCodeBlock, PaseoFields, PaseoHero, Section, StatusPill } from "./paseo";
import {
  bgWaitLabel,
  extractPiToolText,
  formatWaitTimeout,
  parseBgWaitInput,
  parseBgWaitOutput,
  parseSubagentSupervisorInput,
  shortRunId,
  subagentSupervisorLabel,
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
  const label = subagentSupervisorLabel(input);
  const subtitle = [agent, runId ? `run ${shortRunId(runId)}` : undefined].filter(Boolean).join(" · ");

  return (
    <View style={styles.paseoStack}>
      <PaseoHero
        icon="Reply"
        title={label}
        subtitle={subtitle || undefined}
        color={palette.categoryColors.agent}
        styles={styles}
      />
      {parsed.action === "reply" ? (
        <>
          {parsed.message ? <MessageBlock label="Reply message" text={parsed.message} styles={styles} /> : null}
          <Section title="Request" styles={styles}>
            <PaseoFields
              fields={[
                ["Request ID", replyTo],
                ["Run", runId],
                ["Agent", agent],
                ["Confirmation", envelope?.text || undefined],
              ]}
              palette={palette}
              styles={styles}
            />
          </Section>
        </>
      ) : (
        <>
          <Section title="Query" styles={styles}>
            <PaseoFields
              fields={[
                ["Action", parsed.action || undefined],
                ["To", parsed.to],
                ["Message", parsed.message],
              ]}
              palette={palette}
              styles={styles}
            />
          </Section>
          {envelope?.text ? (
            <MessageBlock label="Result" text={envelope.text} styles={styles} />
          ) : (
            <Text style={styles.empty}>No pending supervisor requests returned.</Text>
          )}
        </>
      )}
    </View>
  );
}

function waitStatus(output: ReturnType<typeof parseBgWaitOutput>): string | undefined {
  if (!output) return undefined;
  if (output.waitReason === "window_elapsed") return "Timed out";
  if (output.waitReason === "supervisor_request") return "Supervisor request";
  if (output.completions.length > 0) return "Completed";
  if (output.text) return "Waiting";
  return undefined;
}

export function BgWaitToolDetail({ input, output, theme, palette, styles }: DetailProps) {
  const parsed = parseBgWaitInput(input);
  const summary = parseBgWaitOutput(output);
  const label = bgWaitLabel(input);
  const timeout = formatWaitTimeout(parsed.timeoutMs);
  const target = parsed.id ? `run ${shortRunId(parsed.id)}` : parsed.all === true ? "all runs" : "next run";
  const subtitle = [target, timeout ? `${timeout} timeout` : undefined].filter(Boolean).join(" · ");
  const status = waitStatus(summary);

  return (
    <View style={styles.paseoStack}>
      <PaseoHero
        icon="Hourglass"
        title={label}
        subtitle={subtitle || undefined}
        status={status}
        palette={palette}
        color={palette.categoryColors.agent}
        styles={styles}
      />
      {status ? <StatusPill value={status} palette={palette} styles={styles} /> : null}
      {summary?.headline ? (
        <Section title="Summary" styles={styles}>
          <Text selectable style={styles.detailText}>
            {summary.headline}
          </Text>
        </Section>
      ) : null}
      <Section title="Wait" styles={styles}>
        <PaseoFields
          fields={[
            ["Target", parsed.id ?? (parsed.all === true ? "All active runs" : "First finished run")],
            ["Timeout", timeout],
            ["Wait for all", parsed.all],
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
      </Section>
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

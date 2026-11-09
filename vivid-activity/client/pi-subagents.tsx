import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { parsePiSubagentCall } from "../shared/pi-subagents";
import { bgWaitSummary, extractPiToolText, formatWaitTimeout, notInHeader, parseBgWaitInput, parseBgWaitOutput, parseSubagentSupervisorInput, subagentSupervisorSummary, textAfterHeader, type ActivityPalette, } from "../shared/presentation";
import type { ActivityStyles } from "./activity";
import { ReasoningMarkdown } from "./activity-details";
import { FieldsSection, PaseoCodeBlock, Section, StatusPill } from "./paseo";

type Theme = PluginTimelineItemProps["theme"];

type DetailProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
  agentType?: string;
  description?: string;
  childSessionId?: string;
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

export function PiSubagentToolDetail({ input, output, theme, palette, styles, agentType, description, childSessionId }: DetailProps) {
  const parsed = parsePiSubagentCall(input, output);
  return (
    <View style={styles.paseoStack}>
      <FieldsSection title={t("ui.agent")} fields={[
        [t("ui.agentId"), parsed.agentId], [t("ui.type"), agentType ?? parsed.agentType],
        [t("ui.description"), parsed.description ?? description], [t("ui.session2"), childSessionId],
        [t("ui.mode"), parsed.wait === true ? t("ui.waitUntilFinished") : parsed.wait === false ? t("ui.checkResultsWithoutWaiting") : undefined],
      ]} palette={palette} styles={styles} />
      {parsed.status ? <StatusPill value={parsed.status} palette={palette} styles={styles} /> : null}
      <FieldsSection title={t("ui.usage")} fields={[
        [t("ui.toolCallCount"), parsed.toolUses], [t("ui.token"), parsed.tokens],
        [t("ui.context2"), parsed.context], [t("ui.duration"), parsed.duration],
      ]} palette={palette} styles={styles} />
      <FieldsSection title={t("ui.transcript")} fields={[[t("ui.outputFile"), parsed.outputFile]]} palette={palette} styles={styles} />
      {parsed.error ? <Section title={t("ui.error")} styles={styles}>
        <Text selectable style={[styles.detailText, { color: palette.statusColors.failed }]}>{parsed.error}</Text>
      </Section> : null}
      {parsed.notice ? <Text style={styles.mutedText}>{parsed.notice}</Text> : null}
      {parsed.prompt ? <MessageBlock label={t("ui.prompt")} text={parsed.prompt} styles={styles} /> : null}
      {parsed.message ? <MessageBlock label={t("ui.steerMessage")} text={parsed.message} styles={styles} /> : null}
      {parsed.body ? <Section title={t("ui.result")} styles={styles}>
        <ReasoningMarkdown text={parsed.body} theme={theme} styles={styles} />
      </Section> : null}
    </View>
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
          {message ? <MessageBlock label={t("ui.replyMessage")} text={message} styles={styles} /> : null}
          <FieldsSection
            title={t("ui.request")}
            fields={[
              [t("ui.requestID"), replyTo],
              [t("ui.run"), runId],
              [t("ui.agent"), notInHeader(agent, headerSummary)],
              [t("ui.confirmation"), envelope?.text || undefined],
            ]}
            palette={palette}
            styles={styles}
          />
        </>
      ) : (
        <>
          <FieldsSection
            title={t("ui.query2")}
            fields={[
              [t("ui.action"), knownAction ? undefined : parsed.action || undefined],
              [t("ui.to"), notInHeader(parsed.to, headerSummary)],
              [t("ui.message"), message],
            ]}
            palette={palette}
            styles={styles}
          />
          {resultText ? (
            <MessageBlock label={t("ui.result")} text={resultText} styles={styles} />
          ) : envelope?.text ? null : (
            <Text style={styles.empty}>{t("ui.noPendingSubagentRequests")}</Text>
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
        <Section title={t("ui.overview")} styles={styles}>
          <Text selectable style={styles.detailText}>
            {summary.headline}
          </Text>
        </Section>
      ) : null}
      <FieldsSection
        title={t("ui.wait")}
        fields={[
          [t("ui.run"), parsed.id],
          [t("ui.timeout"), notInHeader(timeout ? t("ui.timeoutValue", { time: timeout }) : undefined, headerSummary)],
          [t("ui.nonblocking"), parsed.nonBlocking],
          [t("ui.stopWhenAttentionIsNeeded"), parsed.stopOnAttention],
          [t("ui.activeRuns"), summary && summary.activeRunIds.length > 0 ? summary.activeRunIds.join(", ") : undefined],
          [
            t("ui.providerEntries"),
            summary && summary.activeProviderItems.length > 0
              ? summary.activeProviderItems.map((item) => `${item.provider}:${item.id}`).join(", ")
              : undefined,
          ],
        ]}
        palette={palette}
        styles={styles}
      />
      {summary && summary.completions.length > 0 ? (
        <Section title={t("ui.completed2", { count: summary.completions.length })} styles={styles}>
          <View style={styles.paseoList}>
            {summary.completions.map((completion) => (
              <View key={`completion-${completion.runId}-${completion.agent ?? "run"}`} style={styles.paseoListItem}>
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {completion.agent ?? t("ui.runFinished")}
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
        <PaseoCodeBlock code={summary.body} language="text" label={t("ui.waitLog")} theme={theme} styles={styles} />
      ) : null}
    </View>
  );
}

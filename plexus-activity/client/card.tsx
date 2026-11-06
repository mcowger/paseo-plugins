import { memo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { formatApiTransition } from "../shared/api-types";
import {
  computeEndToEndTps,
  computeLiveDurationMs,
  formatCost,
  formatEstimatedTps,
  formatMs,
  formatReasoningEffort,
  formatServiceTier,
  formatTokens,
  formatTps,
  isPendingStatus,
} from "../shared/format";
import type { UsageRow } from "../shared/view";
import type { ActivityStyles } from "./styles";

/**
 * One Plexus request as four lines of text.
 *
 * The card shows exactly the values Plexus renders in its API, Model, Tokens, Cost and Perf cells.
 * Status, date, and key are deliberately not rendered; they are carried for correctness only
 * (in-flight detection, ordering, and scope filtering).
 */

export interface ActivityCardProps {
  readonly row: UsageRow;
  /** Skew-corrected client clock; only needed while the request is in flight. */
  readonly now: number | null;
  readonly styles: ActivityStyles;
}

function apiFlags(row: UsageRow): string[] {
  const flags: string[] = [];
  if (row.isStreamed) flags.push("stream");
  if (row.isRaw) flags.push("raw");
  if (row.isPassthrough) flags.push("passthrough");
  if (row.isVisionFallthrough) flags.push("vision");
  return flags;
}

function hasAnyTokens(row: UsageRow): boolean {
  const { tokens } = row;
  return [tokens.input, tokens.cached, tokens.cacheWrite, tokens.output, tokens.reasoning].some(
    (value) => value !== null,
  );
}

function tokenLine(row: UsageRow): string {
  const { tokens } = row;
  const star = tokens.estimated ? "*" : "";
  return `↑${formatTokens(tokens.input)} (c${formatTokens(tokens.cached)}/w${formatTokens(
    tokens.cacheWrite,
  )}) ↓${formatTokens(tokens.output)} (r${formatTokens(tokens.reasoning)})${star}`;
}

function perfLine(row: UsageRow, now: number | null): string {
  const pending = isPendingStatus(row.status);
  const duration =
    row.durationMs ?? (pending && now !== null ? computeLiveDurationMs(row.startTime, now) : null);

  if (pending) {
    const estimate = formatEstimatedTps(row.liveTokensPerSec);
    const durationText = `Dur ${formatMs(duration)}`;
    return estimate === null ? durationText : `${durationText} · ${estimate}`;
  }

  const endToEnd = computeEndToEndTps(row.tokens.output, row.tokens.reasoning, row.durationMs);
  return [
    `Dur ${formatMs(duration)}`,
    `TTFT ${formatMs(row.ttftMs)}`,
    `${formatTps(row.tokensPerSec)} t/s`,
    `E2E ${formatTps(endToEnd)} t/s`,
  ].join(" · ");
}

export const ActivityCard = memo(function ActivityCard({
  row,
  now,
  styles,
}: ActivityCardProps): ReactElement {
  const flags = apiFlags(row);
  const effort = formatReasoningEffort(row.reasoningEffort);
  const tier = formatServiceTier(row.serviceTier, row.requestedServiceTier);
  const pending = isPendingStatus(row.status);
  const showTokens = hasAnyTokens(row) || row.costTotal !== null;

  return (
    <View style={styles.card}>
      <View style={styles.line}>
        <Text style={styles.primaryText}>
          {formatApiTransition(row.incomingApiType, row.outgoingApiType)}
        </Text>
        {flags.length > 0 ? <Text style={styles.secondaryText}>{flags.join(" · ")}</Text> : null}
      </View>

      <View style={styles.line}>
        <Text style={styles.primaryText}>{row.modelSlug ?? "-"}</Text>
        {effort !== null ? <Text style={styles.secondaryText}>· {effort}</Text> : null}
        {tier !== null ? <Text style={styles.secondaryText}>· {tier}</Text> : null}
      </View>

      {showTokens ? (
        <Text style={styles.monoText}>
          {tokenLine(row)} · {formatCost(row.costTotal)}
        </Text>
      ) : (
        <Text style={styles.secondaryText}>{pending ? "usage pending" : "no usage reported"}</Text>
      )}

      <Text style={styles.perfText}>{perfLine(row, now)}</Text>
    </View>
  );
});

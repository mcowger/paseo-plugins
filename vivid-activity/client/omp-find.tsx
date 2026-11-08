import { joinList } from "../shared/i18n";
import { t } from "../shared/text";
import React from "react";
import { Text, View } from "react-native";
import { parseOmpFindResult } from "../shared/omp-find";
import type { ActivityStyles } from "./activity";

type OmpFindToolDetailProps = { input: unknown; output: unknown; styles: ActivityStyles };

export function OmpFindToolDetail({ input, output, styles }: OmpFindToolDetailProps) {
  const result = parseOmpFindResult(input, output);
  if (!result) return null;
  const summary = [
    result.listed !== undefined ? t("ui.listed", { count: result.listed }) : undefined,
    result.judged !== undefined ? t("ui.evaluated", { count: result.judged }) : undefined,
    result.filesRead !== undefined ? t("ui.filesRead", { count: result.filesRead }) : undefined,
  ].filter(Boolean).join(t("ui.metaSeparator"));
  return (
    <View style={styles.section}>
      {result.query ? <Text selectable style={styles.detailText}>{result.query}</Text> : null}
      {result.path ? <Text selectable style={styles.mutedText}>{t("ui.scopeValue", { value: result.path })}</Text> : null}
      {result.keywords.length ? <Text selectable style={styles.mutedText}>{t("ui.keywordsValue", { value: joinList(result.keywords) })}</Text> : null}
      {summary ? <Text style={styles.mutedText}>{summary}</Text> : null}
      {result.hits.length ? result.hits.map((hit) => (
        <View key={hit.path} style={styles.section}>
          <Text selectable style={styles.detailText}>
            {hit.path}{hit.score !== undefined ? t("ui.scoreSuffix", { score: Math.round(hit.score * 100) }) : ""}
          </Text>
          {hit.ranges.map((range, index) => (
            <Text key={`${range.start}-${range.end}-${index}`} selectable style={styles.mutedText}>
              {range.start === range.end ? t("ui.line", { line: range.start }) : t("ui.lines", { start: range.start, end: range.end })}
              {range.snippet ? `  ${range.snippet}` : ""}
            </Text>
          ))}
        </View>
      )) : <Text style={styles.empty}>{t("ui.noMatchingFiles")}</Text>}
    </View>
  );
}

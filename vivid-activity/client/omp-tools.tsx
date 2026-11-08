import React from "react";
import { Text, View } from "react-native";
import { t } from "../shared/text";
import { isOmpEvalTool, isOmpWebSearchTool, parseOmpEval, parseOmpWebSearch } from "../shared/omp-tools";
import type { ActivityStyles } from "./activity";

type Props = { input: unknown; output: unknown; running?: boolean; styles: ActivityStyles };

function statusText(status: "running" | "error" | "complete"): string {
  if (status === "running") return t("ui.running");
  return status === "error" ? t("ui.failed") : t("ui.completed");
}

export { isOmpEvalTool, isOmpWebSearchTool };

export function OmpEvalToolDetail({ input, output, running, styles }: Props) {
  const detail = parseOmpEval(input, output, running);
  return (
    <View style={styles.section}>
      <Text style={styles.mutedText}>{statusText(detail.status)}</Text>
      {detail.title ? <Text style={styles.detailText}>{detail.title}</Text> : null}
      {detail.code ? <Text selectable style={styles.detailText}>{detail.code}</Text> : null}
      {detail.result ? <Text selectable style={styles.mutedText}>{detail.result}</Text> : null}
      {detail.cells.map((cell, index) => (
        <View key={`${cell.title ?? "cell"}-${index}`} style={styles.section}>
          {cell.title ? <Text style={styles.detailText}>{cell.title}</Text> : null}
          {cell.code ? <Text selectable style={styles.detailText}>{cell.code}</Text> : null}
          {cell.output ? <Text selectable style={styles.mutedText}>{cell.output}</Text> : null}
        </View>
      ))}
      {detail.rawOutput ? <Text selectable style={styles.mutedText}>{detail.rawOutput}</Text> : null}
      {!detail.code && !detail.result && !detail.rawOutput && detail.cells.length === 0 && !detail.title ? (
        <Text selectable style={styles.mutedText}>{typeof input === "string" ? input : JSON.stringify(input ?? "")}</Text>
      ) : null}
    </View>
  );
}

export function OmpWebSearchToolDetail({ input, output, running, styles }: Props) {
  const detail = parseOmpWebSearch(input, output, running);
  return (
    <View style={styles.section}>
      <Text style={styles.mutedText}>{statusText(detail.status)}</Text>
      {detail.query ? <Text selectable style={styles.detailText}>{t("ui.queryValue", { value: detail.query })}</Text> : null}
      {detail.results.map((result, index) => (
        <View key={`${result.url ?? result.title ?? "result"}-${index}`} style={styles.section}>
          {result.title ? <Text selectable style={styles.detailText}>{result.title}</Text> : null}
          {result.url ? <Text selectable style={styles.mutedText}>{result.url}</Text> : null}
          {result.snippet ? <Text selectable style={styles.mutedText}>{result.snippet}</Text> : null}
        </View>
      ))}
      {detail.rawOutput ? <Text selectable style={styles.mutedText}>{detail.rawOutput}</Text> : null}
      {!detail.query && detail.results.length === 0 && !detail.rawOutput && input !== undefined ? (
        <Text selectable style={styles.detailText}>{typeof input === "string" ? input : JSON.stringify(input)}</Text>
      ) : null}
    </View>
  );
}

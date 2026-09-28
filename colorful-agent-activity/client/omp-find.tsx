import React from "react";
import { Text, View } from "react-native";
import { parseOmpFindResult } from "../shared/omp-find";
import type { ActivityStyles } from "./activity";

type OmpFindToolDetailProps = { input: unknown; output: unknown; styles: ActivityStyles };

export function OmpFindToolDetail({ input, output, styles }: OmpFindToolDetailProps) {
  const result = parseOmpFindResult(input, output);
  if (!result) return <Text style={styles.empty}>No find results returned.</Text>;
  const summary = [
    result.listed !== undefined ? `${result.listed} listed` : undefined,
    result.judged !== undefined ? `${result.judged} judged` : undefined,
    result.filesRead !== undefined ? `${result.filesRead} files read` : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <View style={styles.section}>
      {result.query ? <Text selectable style={styles.detailText}>{result.query}</Text> : null}
      {result.path ? <Text selectable style={styles.mutedText}>Scope: {result.path}</Text> : null}
      {result.keywords.length ? <Text selectable style={styles.mutedText}>Keywords: {result.keywords.join(", ")}</Text> : null}
      {summary ? <Text style={styles.mutedText}>{summary}</Text> : null}
      {result.hits.length ? result.hits.map((hit) => (
        <View key={hit.path} style={styles.section}>
          <Text selectable style={styles.detailText}>
            {hit.path}{hit.score !== undefined ? ` · ${Math.round(hit.score * 100)}%` : ""}
          </Text>
          {hit.ranges.map((range, index) => (
            <Text key={`${range.start}-${range.end}-${index}`} selectable style={styles.mutedText}>
              {range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`}
              {range.snippet ? `  ${range.snippet}` : ""}
            </Text>
          ))}
        </View>
      )) : <Text style={styles.empty}>No matching files.</Text>}
    </View>
  );
}

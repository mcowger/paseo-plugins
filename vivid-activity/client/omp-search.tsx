import React, { useState } from "react";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import { parseOmpSearchResult, parseSearchDisplay } from "../shared/omp-search";
import type { OmpSearchResult } from "../shared/omp-search";
import { t } from "../shared/text";
import type { ActivityStyles } from "./activity";
import { OutputCopyButtons } from "./copy-button";
import { outputView, stripAnsi } from "../shared/presentation";

type Props = { input?: unknown; output?: unknown; detail?: { input?: unknown; output?: unknown }; styles: ActivityStyles; running?: boolean };
function parsed(props: Props, kind: "grep" | "glob"): OmpSearchResult {
  const normalized = props.detail as unknown as { details?: unknown } | undefined;
  const output = props.output ?? props.detail?.output ?? (normalized?.details ? normalized : undefined);
  return parseOmpSearchResult(props.input ?? props.detail?.input, output, kind);
}
function Status({ result, running, styles }: { result: OmpSearchResult; running?: boolean; styles: ActivityStyles }) {
  return <>
    {running ? <Text style={styles.mutedText}>{t("ui.running")}</Text> : null}
    {result.error ? <Text selectable style={styles.empty}>{result.error}</Text> : null}
  </>;
}

export function OmpGrepToolDetail(props: Props) {
  const result = parsed(props, "grep");
  return <View style={props.styles.section}>
    {result.pattern ? <Text selectable style={props.styles.detailText}>{result.pattern}</Text> : null}
    {result.path ? <Text selectable style={props.styles.mutedText}>{result.path}</Text> : null}
    <Status result={result} running={props.running} styles={props.styles} />
    {result.text.length ? <Text selectable style={props.styles.mutedText}>{result.text.join("\n")}</Text> : result.fileMatches.map((file) => <Text key={file.path} selectable style={props.styles.detailText}>{file.path}{file.count !== undefined ? ` (${file.count})` : ""}</Text>)}
  </View>;
}

export function OmpGlobToolDetail(props: Props) {
  const result = parsed(props, "glob");
  return <View style={props.styles.section}>
    {result.pattern ? <Text selectable style={props.styles.detailText}>{result.pattern}</Text> : null}
    <Status result={result} running={props.running} styles={props.styles} />
    {result.files.length ? result.files.map((path, index) => <Text key={`${index}:${path}`} selectable style={props.styles.detailText}>{path}</Text>) : null}
    {result.text.length && (result.text.join("\n") !== result.files.join("\n")) ? <Text selectable style={props.styles.mutedText}>{result.text.join("\n")}</Text> : null}
  </View>;
}

/** Compact renderer used by the search-detail view for Paseo's annotated output. */
export function SearchDisplay({ content, styles, theme }: { content: string; styles: ActivityStyles; theme: PluginTimelineItemProps["theme"] }) {
  const [showAll, setShowAll] = useState(false);
  const clean = stripAnsi(content);
  const view = outputView(content, clean, showAll, false);
  const lines = parseSearchDisplay(view.shown);
  return <View style={styles.section}>
    <View style={styles.codeHeader}>
      <Text style={styles.detailLabel}>{t("ui.result")}</Text>
      <OutputCopyButtons clean={clean} raw={content} label={t("ui.copyOutput")} theme={theme} styles={styles} />
    </View>
    <Text selectable style={styles.mutedText}>{lines.map((line, index) => <React.Fragment key={index}>
      {index > 0 ? "\n" : null}
      {line.kind === "match" ? <Text style={[styles.detailText, { fontWeight: "600" }]}>{line.text}</Text>
        : line.kind === "file" ? <Text style={[styles.detailText, { fontWeight: "700" }]}>{line.text}</Text>
        : line.text}
    </React.Fragment>)}</Text>
    {view.preview.truncated ? <Pressable accessibilityRole="button" onPress={() => setShowAll(!showAll)} style={styles.showMoreButton}><Text style={styles.showMoreText}>{showAll ? t("ui.collapse") : t("ui.expandAllLinesCharacters", { count: view.preview.totalLines, lines: view.preview.totalLines, characters: view.preview.totalChars.toLocaleString() })}</Text></Pressable> : null}
  </View>;
}

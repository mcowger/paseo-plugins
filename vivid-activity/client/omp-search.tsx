import React from "react";
import { Text, View } from "react-native";
import { parseOmpSearchResult } from "../shared/omp-search";
import type { OmpSearchResult } from "../shared/omp-search";
import { t } from "../shared/text";
import type { ActivityStyles } from "./activity";

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

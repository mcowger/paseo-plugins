import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import { createContext, useContext, type ComponentType } from "react";
import { Text } from "react-native";
import { stripAnsi } from "../shared/presentation";

/** The first expanded row is readable immediately, before syntax highlighting and tool UIs arrive. */
export function plainDetailText(props: any): string {
  const detail = props.data?.detail;
  const value = [props.text, detail?.text, detail?.output, detail?.content, detail?.unifiedDiff, detail?.newString,
    detail?.result, detail?.log, detail?.command, detail?.input, props.data?.presentation?.summary]
    .find((candidate) => typeof candidate === "string" ? candidate.trim().length > 0 : candidate != null);
  const text = typeof value === "string" ? value : value == null ? t("ui.loadingDetails") : JSON.stringify(value, null, 2);
  return stripAnsi(text).slice(0, 4000);
}
export function PlainDetail(props: any) {
  useI18n();
  return <Text selectable numberOfLines={12} style={props.styles?.detailText ?? { color: props.theme?.colors.foreground }}>{plainDetailText(props)}</Text>;
}

export const ActivityDetailsContext = createContext<{ DetailBody: ComponentType<any>; ReasoningText: ComponentType<any> }>({ DetailBody: PlainDetail, ReasoningText: PlainDetail });
export const useActivityDetails = () => useContext(ActivityDetailsContext);

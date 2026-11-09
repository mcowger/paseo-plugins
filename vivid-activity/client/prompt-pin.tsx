import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, type LayoutChangeEvent, type TextStyle, type ViewStyle } from "react-native";
import {
  estimateLines,
  MAX_PROMPT_CHARS,
  PIN_COLLAPSED_LINES,
  pinTitle,
  turnPromptRpc,
  type PromptPin,
  type TurnPromptInput,
  type TurnPromptOutput,
} from "../shared/prompt-pin";
import { activitySettings, DEFAULT_PIN_PROMPT } from "../shared/settings";
import { CopyButton } from "./copy-button";
import type { DensityMetrics } from "./density";
import { foldRuntime } from "./fold-runtime";
import { aria, hue, isDarkTheme, toneColor, withAlpha } from "./kit";
import { Enter } from "./motion";

/**
 * 0.6.0（grok-B2）：钉在最新一段活动上方的「本轮提问」。在哪一行上方由折叠运行时算（shared/prompt-pin.ts），
 * 行组件只问「是不是我」；文字由插件服务端在 daemon 里按位置读出来。全部用 React Native 画，iOS、Android、网页一样。
 */

type Theme = PluginTimelineItemProps["theme"];
type Answer = TurnPromptOutput;

const FONT_SIZE = 13;
const EXPANDED_MAX_HEIGHT = 320;

/** Answers per Agent (by position), so a row that scrolls back into view does not ask again; dropped with the Agent. */
const answers = new Map<string, Map<string, Answer>>();
const asking = new Map<string, Promise<Answer>>();
foldRuntime.onForget((agentId) => void answers.delete(agentId));

function remembered(agentId: string, key: string): Answer | null {
  return answers.get(agentId)?.get(key) ?? null;
}

function ask(agentId: string, key: string, load: () => Promise<Answer>): Promise<Answer> {
  const id = `${agentId}\u0000${key}`;
  const pending = asking.get(id);
  if (pending) return pending;
  const promise = load()
    .catch((): Answer => ({ status: "unavailable", text: "", seq: null, turnId: null, truncated: false }))
    .then((answer) => {
      asking.delete(id);
      // A failed read is asked again next time the strip mounts; a found (or absent) question is not.
      if (answer.status !== "unavailable") {
        let known = answers.get(agentId);
        if (!known) answers.set(agentId, (known = new Map()));
        known.set(key, answer);
      }
      return answer;
    });
  asking.set(id, promise);
  return promise;
}

function usePinSetting(): boolean {
  const settings = useSettings(activitySettings);
  // Not while the settings load: a strip that shows and then goes away is worse than one that comes a moment later.
  return settings.status === "ready" ? settings.values.pinPrompt : settings.status === "error" ? DEFAULT_PIN_PROMPT : false;
}

/**
 * The pin when it goes above this row: a tool or thinking row (`key`, its fold key; `part` > 0 for the later files of
 * one patch) or a summary row (`segment`). Null otherwise, or when 「钉住本轮提问」 is off.
 */
export function usePromptPin(agentId: string, at: { key?: string; part?: number } | { segment: string }): PromptPin | null {
  const segment = "segment" in at ? at.segment : undefined;
  const key = "segment" in at ? undefined : at.key;
  const later = "segment" in at ? false : Boolean(at.part);
  const subscribe = useCallback((listener: () => void) => foldRuntime.subscribePin(agentId, listener), [agentId]);
  // Each row reads only whether the pin is its own, so a moving pin re-renders the two rows it leaves and joins.
  const getPin = useCallback(() => {
    const pin = foldRuntime.pin(agentId);
    if (!pin) return null;
    if (segment !== undefined) return pin.fold && pin.segment === segment ? pin : null;
    return !pin.fold && key !== undefined && pin.key === key && !later ? pin : null;
  }, [agentId, key, later, segment]);
  const pin = useSyncExternalStore(subscribe, getPin, getPin);
  return usePinSetting() ? pin : null;
}

function usePromptText(agentId: string, pin: PromptPin): Answer | null {
  const load = useRpc(turnPromptRpc);
  const epoch = foldRuntime.epoch(agentId);
  const at: TurnPromptInput["at"] = pin.promptSeq !== null && epoch ? { epoch, seq: pin.promptSeq } : null;
  const key = at ? `${at.epoch}|${at.seq}` : `latest|${epoch ?? ""}`;
  const [state, setState] = useState<{ key: string; answer: Answer } | null>(() => {
    const known = remembered(agentId, key);
    return known ? { key, answer: known } : null;
  });
  useEffect(() => {
    const known = remembered(agentId, key);
    if (known) {
      setState({ key, answer: known });
      return;
    }
    let live = true;
    void ask(agentId, key, () => load({ agentId, at })).then((answer) => {
      if (live) setState({ key, answer });
    });
    return () => {
      live = false;
    };
    // `at` is spelled out by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, key, load]);
  return state && state.key === key ? state.answer : null;
}

function pinColors(theme: Theme, mode: string): { mark: string; text: string; ground: string; line: string } {
  const dark = isDarkTheme(theme);
  if (mode === "soft") {
    const muted = theme.colors.foregroundMuted;
    return { mark: muted, text: muted, ground: theme.colors.surface1, line: withAlpha(muted.startsWith("#") ? muted : "#888888", 0.6) };
  }
  if (mode === "theme") {
    const accent = toneColor(theme, "accent", "mark");
    return { mark: accent, text: toneColor(theme, "accent", "text"), ground: toneColor(theme, "accent", "soft"), line: accent };
  }
  const violet = hue(theme, "violet");
  return { mark: violet, text: hue(theme, "violet", "text"), ground: withAlpha(violet, dark ? 0.13 : 0.07), line: violet };
}

/**
 * The strip for a pin: nothing until the question's text is known, and nothing when there is none (an Agent that started
 * on its own, a history that no longer has it).
 */
export function PinnedPrompt({ agentId, pin, theme, mode, metrics }: { agentId: string; pin: PromptPin; theme: Theme; mode: string; metrics: DensityMetrics }) {
  useI18n();
  const answer = usePromptText(agentId, pin);
  // Entrance once when the pin moves down to a new stretch of activity while you watch; not when the chat opens.
  const [fresh] = useState(() => {
    const moved = foldRuntime.pinMovedAt(agentId);
    return moved > 0 && Date.now() - moved < 3000;
  });
  if (!answer || answer.status !== "ok" || !answer.text.trim()) return null;
  return <PinnedPromptView title={pinTitle(pin, answer)} text={answer.text} truncated={answer.truncated} theme={theme} mode={mode} metrics={metrics} fresh={fresh} />;
}

/** 「📌 本轮提问」, the question in three lines, 「展开全部」 when there is more, and a copy button. */
export function PinnedPromptView({ title, text: raw, truncated, theme, mode, metrics, fresh = false }: {
  title: string;
  text: string;
  truncated: boolean;
  theme: Theme;
  mode: string;
  metrics: DensityMetrics;
  fresh?: boolean;
}) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(0);
  const colors = useMemo(() => pinColors(theme, mode), [mode, theme]);
  const styles = useMemo(() => {
    const lineHeight = metrics.lineHeight + 3;
    return {
      strip: {
        // First thing in the row, which pulls itself up by its negative top margin into the gap above it (a native list
        // cell clips there): start below that.
        marginTop: 2 - metrics.marginTop,
        marginBottom: 4,
        borderRadius: 10,
        borderLeftWidth: 3,
        borderLeftColor: colors.line,
        backgroundColor: colors.ground,
        paddingTop: 5,
        paddingBottom: 6,
        paddingLeft: 9,
        paddingRight: 6,
        gap: 2,
        minWidth: 0,
      } satisfies ViewStyle,
      header: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 } satisfies ViewStyle,
      title: { color: colors.text, fontSize: 12, fontWeight: "700", lineHeight: 16, flexShrink: 1, minWidth: 0 } satisfies TextStyle,
      body: { color: theme.colors.foreground, fontSize: FONT_SIZE, lineHeight } satisfies TextStyle,
      toggle: { color: colors.text, fontSize: 11, fontWeight: "600", lineHeight: 15 } satisfies TextStyle,
      note: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 } satisfies TextStyle,
      copy: {
        copyButton: { alignItems: "center", borderRadius: 2, flexDirection: "row", gap: 3, paddingHorizontal: 4, paddingVertical: 2, flexShrink: 0 } satisfies ViewStyle,
        copyText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 } satisfies TextStyle,
      },
    };
  }, [colors, metrics.lineHeight, metrics.marginTop, theme]);
  const onLayout = useCallback((event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width), []);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const text = raw.trim();
  // Inner width: the strip less its border and padding, and a little slack so a borderline case offers 「展开全部」.
  const longer = estimateLines(text, Math.max(0, width - 18) * 0.94, FONT_SIZE) > PIN_COLLAPSED_LINES;
  const open = expanded && longer;
  return (
    <Enter active={fresh}>
      <View style={styles.strip} onLayout={onLayout}>
        <View style={styles.header}>
          <Icon name="Pin" size={12} color={colors.mark} />
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 4 }} />
          <CopyButton value={raw} label={truncated ? t("ui.copyFirstCharacters", { title: title, count: MAX_PROMPT_CHARS }) : t("ui.copy", { label: title })} theme={theme} styles={styles.copy} />
        </View>
        {open ? (
          <>
            <ScrollView style={{ maxHeight: EXPANDED_MAX_HEIGHT }} nestedScrollEnabled showsVerticalScrollIndicator>
              <Text selectable style={styles.body}>{text}</Text>
              {truncated ? <Text style={styles.note}>{t("ui.thisPromptIsLongOnly", { count: MAX_PROMPT_CHARS })}</Text> : null}
            </ScrollView>
            <Pressable accessibilityRole="button" accessibilityLabel={t("ui.collapse2", { title: title })} {...aria({ expanded: true })} onPress={toggle} hitSlop={8} style={{ alignSelf: "flex-start" }}>
              <Text style={styles.toggle}>{t("ui.collapse")}</Text>
            </Pressable>
          </>
        ) : longer ? (
          <Pressable accessibilityRole="button" accessibilityHint={t("ui.expandFullText")} {...aria({ expanded: false })} onPress={toggle} style={{ gap: 1 }}>
            <Text numberOfLines={PIN_COLLAPSED_LINES} style={styles.body}>{text}</Text>
            <Text style={styles.toggle}>{t("ui.expandAll")}</Text>
          </Pressable>
        ) : (
          <Text selectable style={styles.body}>{text}</Text>
        )}
      </View>
    </Enter>
  );
}

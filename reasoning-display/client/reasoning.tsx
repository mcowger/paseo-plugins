import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PluginSurfaceProps,
  type PluginTimelineItemProps,
  useRpc,
} from "@getpaseo/plugin";
import { Icon, useRevealedText } from "@getpaseo/plugin/react-native";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { z } from "zod";
import {
  DEFAULT_REASONING_SETTINGS,
  getReasoningSettingsRpc,
  reasoningItemDataSchema,
  reasoningSettingsQueryKey,
  setReasoningSettingsRpc,
  type ReasoningDisplayMode,
  type ReasoningSettings,
} from "../shared/reasoning";

const MAX_REASONING_HEIGHT = 400;
const DISPLAY_MODE_INFO: Record<
  ReasoningDisplayMode,
  { label: string; description: string; icon: string }
> = {
  expand_last: {
    label: "Expand last",
    description: "Newest reasoning block starts expanded; older blocks stay collapsed.",
    icon: "Sparkles",
  },
  collapsed: {
    label: "Collapsed",
    description: "All reasoning blocks start collapsed by default.",
    icon: "Minimize2",
  },
  expanded: {
    label: "Always expand",
    description: "Every reasoning block starts fully expanded.",
    icon: "Maximize2",
  },
};

const LOG_PREFIX = "[reasoning-display]";
let isDebugLoggingEnabled = false;

function logReasoning(event: string, details: Record<string, unknown>): void {
  if (!isDebugLoggingEnabled) return;
  const formatted = Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(`${LOG_PREFIX} event=${event} ${formatted}`);
}

type ReasoningItemData = z.output<typeof reasoningItemDataSchema>;

interface MarkdownStyles {
  container: StyleProp<ViewStyle>;
  paragraph: StyleProp<TextStyle>;
  heading: StyleProp<TextStyle>;
  bullet: StyleProp<TextStyle>;
  bulletRow: StyleProp<ViewStyle>;
  quote: StyleProp<TextStyle>;
  code: StyleProp<TextStyle>;
  codeBlock: StyleProp<TextStyle>;
  spacer: StyleProp<ViewStyle>;
  scroll: StyleProp<ViewStyle>;
}

interface ReasoningSettingsStyles {
  screen: StyleProp<ViewStyle>;
  title: StyleProp<TextStyle>;
  sectionTitle: StyleProp<TextStyle>;
  description: StyleProp<TextStyle>;
  fieldGroup: StyleProp<ViewStyle>;
  fieldLabel: StyleProp<TextStyle>;
  selectTrigger: StyleProp<ViewStyle>;
  selectTriggerOpen: StyleProp<ViewStyle>;
  selectTriggerText: StyleProp<TextStyle>;
  dropdownMenu: StyleProp<ViewStyle>;
  dropdownOption: StyleProp<ViewStyle>;
  dropdownOptionSelected: StyleProp<ViewStyle>;
  dropdownOptionContent: StyleProp<ViewStyle>;
  dropdownOptionLabel: StyleProp<TextStyle>;
  dropdownOptionLabelSelected: StyleProp<TextStyle>;
  dropdownOptionDescription: StyleProp<TextStyle>;
  toggleCard: StyleProp<ViewStyle>;
  toggleCardActive: StyleProp<ViewStyle>;
  toggleTextContainer: StyleProp<ViewStyle>;
  toggleTitle: StyleProp<TextStyle>;
  toggleDescription: StyleProp<TextStyle>;
  status: StyleProp<TextStyle>;
}

const latestReasoningTimestamps = new Map<string, number>();
const latestReasoningListeners = new Set<() => void>();

function updateLatestReasoningTimestamp(agentId: string, timestamp: number): void {
  const current = latestReasoningTimestamps.get(agentId) ?? 0;
  if (timestamp > current) {
    latestReasoningTimestamps.set(agentId, timestamp);
    logReasoning("store-update", { agentId, prev: current, next: timestamp });
    for (const listener of latestReasoningListeners) {
      listener();
    }
  }
}

function subscribeLatestReasoning(listener: () => void): () => void {
  latestReasoningListeners.add(listener);
  return () => {
    latestReasoningListeners.delete(listener);
  };
}

function useReasoningSettings(): ReasoningSettings {
  const getSettings = useRpc(getReasoningSettingsRpc);
  const { data } = useQuery({
    queryKey: reasoningSettingsQueryKey,
    queryFn: () => getSettings({}),
  });
  const settings = data ?? DEFAULT_REASONING_SETTINGS;
  isDebugLoggingEnabled = Boolean(settings.debug);
  return settings;
}

function useIsLatestReasoning(agentId: string, timestamp: Date, isStreaming: boolean): boolean {
  const itemTime = timestamp.getTime();
  if (isStreaming || itemTime > (latestReasoningTimestamps.get(agentId) ?? 0)) {
    updateLatestReasoningTimestamp(agentId, itemTime);
  }

  const latestTime = useSyncExternalStore(
    subscribeLatestReasoning,
    () => latestReasoningTimestamps.get(agentId) ?? 0,
    () => 0,
  );

  const isLatest = isStreaming || (latestTime > 0 && itemTime >= latestTime);
  return isLatest;
}

function renderInlineMarkdown(text: string, styles: MarkdownStyles): ReactNode[] {
  const tokenPattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let nodeIndex = 0;

  while ((match = tokenPattern.exec(text)) !== null) {
    const start = match.index;
    const token = match[0];
    if (start > cursor) nodes.push(text.slice(cursor, start));

    let tokenStyle = styles.paragraph;
    let tokenText = token;
    if (token.startsWith("**") || token.startsWith("__")) {
      tokenStyle = [styles.paragraph, { fontWeight: "700" }];
      tokenText = token.slice(2, -2);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokenStyle = styles.code;
      tokenText = token.slice(1, -1);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      tokenStyle = [styles.paragraph, { fontStyle: "italic" }];
      tokenText = token.slice(1, -1);
    }
    nodes.push(
      <Text key={`inline-${nodeIndex}`} style={tokenStyle}>
        {tokenText}
      </Text>,
    );
    nodeIndex += 1;
    cursor = start + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function InlineMarkdown({ text, styles }: { text: string; styles: MarkdownStyles }) {
  return <Text style={styles.paragraph}>{renderInlineMarkdown(text, styles)}</Text>;
}

function MarkdownContent({ text, styles }: { text: string; styles: MarkdownStyles }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let codeLines: string[] | null = null;

  const addCodeBlock = (key: string, linesToAdd: string[]) => {
    blocks.push(
      <Text key={key} selectable style={styles.codeBlock}>
        {linesToAdd.join("\n")}
      </Text>,
    );
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (codeLines !== null) {
      if (trimmed.startsWith("```") || trimmed === "```") {
        addCodeBlock(`code-${blocks.length}`, codeLines);
        codeLines = null;
      } else {
        codeLines.push(line);
      }
      return;
    }

    if (trimmed.startsWith("```")) {
      codeLines = [];
      return;
    }
    if (trimmed.length === 0) {
      blocks.push(<View key={`space-${blocks.length}`} style={styles.spacer} />);
      return;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      blocks.push(
        <Text key={`heading-${blocks.length}-${heading[1]}`} selectable style={styles.heading}>
          {renderInlineMarkdown(heading[1], styles)}
        </Text>,
      );
      return;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      blocks.push(
        <View key={`unordered-${blocks.length}-${unordered[1]}`} style={styles.bulletRow}>
          <Text style={styles.bullet}>•</Text>
          <InlineMarkdown text={unordered[1]} styles={styles} />
        </View>,
      );
      return;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      blocks.push(
        <View key={`ordered-${blocks.length}-${ordered[1]}`} style={styles.bulletRow}>
          <Text style={styles.bullet}>{ordered[1]}.</Text>
          <InlineMarkdown text={ordered[2]} styles={styles} />
        </View>,
      );
      return;
    }

    if (trimmed.startsWith(">")) {
      blocks.push(
        <Text key={`quote-${blocks.length}-${trimmed}`} selectable style={styles.quote}>
          {renderInlineMarkdown(trimmed.slice(1).trimStart(), styles)}
        </Text>,
      );
      return;
    }

    blocks.push(
      <InlineMarkdown key={`paragraph-${blocks.length}-${line}`} text={line} styles={styles} />,
    );
  });

  if (codeLines !== null) addCodeBlock(`code-${blocks.length}`, codeLines);
  return <View style={styles.container}>{blocks}</View>;
}

function ThinkingBody({
  text,
  phase,
  styles,
}: {
  text: string;
  phase: "streaming" | "complete";
  styles: MarkdownStyles;
}) {
  const revealedText = useRevealedText(text, phase);
  const scrollRef = useRef<ScrollView | null>(null);
  const isNearBottom = useRef(true);

  useEffect(() => {
    logReasoning("body-mount", { phase, textLength: text.length });
    return () => {
      logReasoning("body-unmount", { phase, textLength: text.length });
    };
  }, [phase, text.length]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    isNearBottom.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 32;
  }, []);
  const handleContentSizeChange = useCallback(() => {
    if (isNearBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  return (
    <ScrollView
      ref={scrollRef}
      nestedScrollEnabled
      onContentSizeChange={handleContentSizeChange}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator
      style={styles.scroll}
    >
      <MarkdownContent text={revealedText} styles={styles} />
    </ScrollView>
  );
}

function useMarkdownStyles(theme: PluginTimelineItemProps["theme"]): MarkdownStyles {
  return useMemo(
    () => ({
      container: { gap: 6, paddingBottom: 12, paddingHorizontal: 13, paddingTop: 8 },
      paragraph: {
        color: theme.colors.foreground,
        fontSize: 13,
        lineHeight: 20,
        fontFamily: "monospace",
      },
      heading: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "700",
        lineHeight: 20,
        fontFamily: "monospace",
      },
      bullet: {
        color: theme.colors.foregroundMuted,
        minWidth: 20,
        lineHeight: 20,
        fontFamily: "monospace",
        fontSize: 13,
      },
      bulletRow: { flexDirection: "row", gap: 4, alignItems: "flex-start" },
      quote: {
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.accent,
        color: theme.colors.foregroundMuted,
        paddingLeft: 8,
        lineHeight: 20,
        fontFamily: "monospace",
        fontSize: 13,
      },
      code: {
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        paddingHorizontal: 3,
      },
      codeBlock: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        borderWidth: 1,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
        padding: 10,
      },
      spacer: { height: 4 },
      scroll: {
        maxHeight: MAX_REASONING_HEIGHT,
      },
    }),
    [theme],
  );
}

export function ReasoningTimelineItem({
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<ReasoningItemData>) {
  const settings = useReasoningSettings();
  const mode = settings.mode;
  const isStreaming = item.data.phase === "streaming";
  const isLatest = useIsLatestReasoning(agentId, timestamp, isStreaming);
  const preferredExpanded =
    mode === "expanded" || (mode === "expand_last" && isLatest);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const isExpanded = isStreaming || (userExpanded !== null ? userExpanded : preferredExpanded);
  const styles = useMarkdownStyles(theme);

  useEffect(() => {
    logReasoning("item-mount", {
      agentId,
      timestamp: timestamp.toISOString(),
      phase: item.data.phase,
    });
    return () => {
      logReasoning("item-unmount", {
        agentId,
        timestamp: timestamp.toISOString(),
        phase: item.data.phase,
      });
    };
  }, [agentId, item.data.phase, timestamp]);

  logReasoning("item-render", {
    agentId,
    timestamp: timestamp.toISOString(),
    phase: item.data.phase,
    mode,
    isStreaming,
    isLatest,
    preferredExpanded,
    userExpanded: userExpanded === null ? "auto" : userExpanded,
    isExpanded,
  });

  const toggleExpanded = useCallback(() => {
    const nextState = !isExpanded;
    logReasoning("user-toggle", { agentId, from: isExpanded, to: nextState });
    setUserExpanded(nextState);
  }, [agentId, isExpanded]);
  const cardStyle = useMemo(
    () => ({
      marginHorizontal: -13,
      marginVertical: 2,
    }),
    [],
  );
  const pressableStyle = useMemo(
    () => ({
      borderColor: "transparent",
      borderRadius: 8,
      borderWidth: 1,
      overflow: "hidden" as const,
      paddingHorizontal: 8,
      paddingVertical: 3,
    }),
    [],
  );
  const pressableExpandedStyle = useMemo(
    () => ({
      backgroundColor: theme.colors.surface1,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      borderColor: theme.colors.border,
    }),
    [theme.colors.border, theme.colors.surface1],
  );
  const headerStyle = useMemo(
    () => ({
      alignItems: "center" as const,
      flexDirection: "row" as const,
    }),
    [],
  );
  const iconBadgeStyle = useMemo(
    () => ({
      alignItems: "center" as const,
      borderRadius: 10,
      height: 20,
      justifyContent: "center" as const,
      marginRight: 4,
      width: 20,
    }),
    [],
  );
  const headerTitleStyle = useMemo(
    () => ({
      color: theme.colors.foregroundMuted,
      fontFamily: "monospace",
      fontSize: 13,
      lineHeight: 20,
    }),
    [theme.colors.foregroundMuted],
  );
  const headerTitleActiveStyle = useMemo(
    () => ({ color: theme.colors.foreground }),
    [theme.colors.foreground],
  );
  const detailStyle = useMemo(
    () => ({
      backgroundColor: theme.colors.surface0,
      borderBottomLeftRadius: 8,
      borderBottomRightRadius: 8,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderTopWidth: 0,
      flexShrink: 1,
      minWidth: 0,
      overflow: "hidden" as const,
    }),
    [theme.colors.border, theme.colors.surface0],
  );

  return (
    <View style={cardStyle}>
      <Pressable
        accessibilityLabel={`${isExpanded ? "Collapse" : "Expand"} thinking`}
        accessibilityRole="button"
        onPress={toggleExpanded}
        style={[pressableStyle, isExpanded && pressableExpandedStyle]}
      >
        <View style={headerStyle}>
          <View style={iconBadgeStyle}>
            {isExpanded ? (
              <Icon color={theme.colors.foreground} name="ChevronDown" size={12} />
            ) : (
              <Icon color={theme.colors.foregroundMuted} name="Brain" size={12} />
            )}
          </View>
          <Text style={[headerTitleStyle, isExpanded && headerTitleActiveStyle]}>Thinking</Text>
        </View>
      </Pressable>
      {isExpanded ? (
        <View style={detailStyle}>
          <ThinkingBody
            text={item.data.text}
            phase={item.data.phase}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
}

export function ReasoningDisplaySettings({ theme, layout }: PluginSurfaceProps) {
  const getSettings = useRpc(getReasoningSettingsRpc);
  const setSettings = useRpc(setReasoningSettingsRpc);
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: reasoningSettingsQueryKey,
    queryFn: () => getSettings({}),
  });
  const mutation = useMutation({
    mutationFn: setSettings,
    onSuccess: (settings) => queryClient.setQueryData(reasoningSettingsQueryKey, settings),
  });
  const settings = data ?? DEFAULT_REASONING_SETTINGS;
  const mode = settings.mode;
  const debug = Boolean(settings.debug);

  const styles = useMemo<ReasoningSettingsStyles>(
    () => ({
      screen: {
        backgroundColor: theme.colors.surface0,
        flex: 1,
        gap: 20,
        maxWidth: 640,
        padding: layout.compact ? 16 : 24,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 20 : 24,
        fontWeight: "700" as const,
      },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 15 : 16,
        fontWeight: "600" as const,
      },
      description: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        lineHeight: 18,
      },
      fieldGroup: {
        gap: 8,
      },
      fieldLabel: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
      },
      selectTrigger: {
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 14,
        paddingVertical: 12,
      },
      selectTriggerOpen: {
        borderColor: theme.colors.accent,
      },
      selectTriggerText: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "500" as const,
      },
      dropdownMenu: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        marginTop: 4,
        overflow: "hidden" as const,
      },
      dropdownOption: {
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 14,
        paddingVertical: 12,
      },
      dropdownOptionSelected: {
        backgroundColor: theme.colors.surface2,
      },
      dropdownOptionContent: {
        flex: 1,
        gap: 2,
      },
      dropdownOptionLabel: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "500" as const,
      },
      dropdownOptionLabelSelected: {
        color: theme.colors.accent,
        fontWeight: "600" as const,
      },
      dropdownOptionDescription: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
      },
      toggleCard: {
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 14,
        paddingVertical: 12,
      },
      toggleCardActive: {
        borderColor: theme.colors.accent,
      },
      toggleTextContainer: {
        flex: 1,
        gap: 2,
        paddingRight: 12,
      },
      toggleTitle: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "500" as const,
      },
      toggleDescription: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 16,
      },
      status: {
        color: theme.colors.statusDanger,
        fontSize: 13,
      },
    }),
    [layout.compact, theme],
  );

  const handleModeChange = useCallback(
    (nextMode: ReasoningDisplayMode) => mutation.mutate({ mode: nextMode, debug }),
    [debug, mutation],
  );
  const handleDebugToggle = useCallback(
    () => mutation.mutate({ mode, debug: !debug }),
    [debug, mode, mutation],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Reasoning Display</Text>
      <Text style={styles.description}>
        Configure how model reasoning and chain-of-thought blocks appear in the agent timeline.
      </Text>

      <ReasoningSelectDropdown
        disabled={isPending || mutation.isPending}
        mode={mode}
        onSelect={handleModeChange}
        styles={styles}
        theme={theme}
      />

      <View style={styles.fieldGroup}>
        <Text style={styles.sectionTitle}>Diagnostics</Text>
        <Text style={styles.description}>
          Output verbose state transition logs to the developer console for troubleshooting.
        </Text>
        <Pressable
          accessibilityLabel={`Debug logging, ${debug ? "enabled" : "disabled"}`}
          accessibilityRole="switch"
          aria-checked={debug}
          disabled={isPending || mutation.isPending}
          onPress={handleDebugToggle}
          style={[styles.toggleCard, debug && styles.toggleCardActive]}
        >
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleTitle}>Debug logging</Text>
            <Text style={styles.toggleDescription}>
              Log timeline render ticks, streaming phase transitions, and expansion events
            </Text>
          </View>
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              borderWidth: 1.5,
              borderColor: debug ? theme.colors.accent : theme.colors.border,
              backgroundColor: debug ? theme.colors.accent : "transparent",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {debug ? <Icon color={theme.colors.accentForeground} name="Check" size={14} /> : null}
          </View>
        </Pressable>
      </View>

      {mutation.error ? <Text style={styles.status}>{mutation.error.message}</Text> : null}
    </View>
  );
}

function ReasoningSelectDropdown({
  disabled,
  mode,
  onSelect,
  theme,
  styles,
}: {
  disabled: boolean;
  mode: ReasoningDisplayMode;
  onSelect: (mode: ReasoningDisplayMode) => void;
  theme: PluginSurfaceProps["theme"];
  styles: ReasoningSettingsStyles;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const toggleOpen = useCallback(() => setIsOpen((prev) => !prev), []);
  const selectedInfo = DISPLAY_MODE_INFO[mode];

  const handleSelectOption = useCallback(
    (optionMode: ReasoningDisplayMode) => {
      onSelect(optionMode);
      setIsOpen(false);
    },
    [onSelect],
  );

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>Display mode</Text>
      <Pressable
        accessibilityLabel={`Display mode: ${selectedInfo.label}. Click to ${isOpen ? "close" : "open"} dropdown`}
        accessibilityRole="combobox"
        aria-expanded={isOpen}
        disabled={disabled}
        onPress={toggleOpen}
        style={[styles.selectTrigger, isOpen && styles.selectTriggerOpen]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
          <Icon color={theme.colors.accent} name={selectedInfo.icon} size={16} />
          <Text style={styles.selectTriggerText}>{selectedInfo.label}</Text>
        </View>
        <Icon
          color={theme.colors.foregroundMuted}
          name={isOpen ? "ChevronUp" : "ChevronDown"}
          size={16}
        />
      </Pressable>

      {isOpen ? (
        <View style={styles.dropdownMenu}>
          {(["expand_last", "collapsed", "expanded"] as const).map((optionMode, index) => {
            const isSelected = mode === optionMode;
            const optionInfo = DISPLAY_MODE_INFO[optionMode];
            return (
              <Pressable
                key={optionMode}
                accessibilityLabel={`${optionInfo.label}${isSelected ? ", selected" : ""}`}
                accessibilityRole="button"
                onPress={() => handleSelectOption(optionMode)}
                style={[
                  styles.dropdownOption,
                  isSelected && styles.dropdownOptionSelected,
                  index > 0 && { borderTopWidth: 1, borderTopColor: theme.colors.border },
                ]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                  <Icon
                    color={isSelected ? theme.colors.accent : theme.colors.foregroundMuted}
                    name={optionInfo.icon}
                    size={16}
                  />
                  <View style={styles.dropdownOptionContent}>
                    <Text
                      style={[
                        styles.dropdownOptionLabel,
                        isSelected && styles.dropdownOptionLabelSelected,
                      ]}
                    >
                      {optionInfo.label}
                    </Text>
                    <Text style={styles.dropdownOptionDescription}>
                      {optionInfo.description}
                    </Text>
                  </View>
                </View>
                {isSelected ? (
                  <Icon color={theme.colors.accent} name="Check" size={16} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

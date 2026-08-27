import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Icon,
  type PluginSurfaceProps,
  type PluginTimelineItemProps,
  useAgent,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  DEFAULT_REASONING_DISPLAY_MODE,
  getLatestReasoningQueryKey,
  getReasoningExpansionState,
  getReasoningSettingsRpc,
  reasoningItemDataSchema,
  reasoningSettingsQueryKey,
  reasoningDisplayModeSchema,
  setReasoningSettingsRpc,
  type ReasoningDisplayMode,
} from "./reasoning.shared";

const TIMELINE_PAGE_LIMIT = 100;
const MAX_REASONING_HEIGHT = 400;
const DISPLAY_MODES = reasoningDisplayModeSchema.options;
const DISPLAY_MODE_LABELS: Record<ReasoningDisplayMode, string> = {
  collapsed: "Collapsed",
  expand_last: "Expand last",
  expanded: "Always expand",
};

type ReasoningItemData = z.output<typeof reasoningItemDataSchema>;
type PaseoApi = ReturnType<typeof usePaseo>;
type PaseoAgent = ReturnType<PaseoApi["agents"]["ref"]>;

interface LatestReasoning {
  timestamp: number;
}

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
  description: StyleProp<TextStyle>;
  option: StyleProp<ViewStyle>;
  selectedOption: StyleProp<ViewStyle>;
  optionText: StyleProp<TextStyle>;
  selectedOptionText: StyleProp<TextStyle>;
  status: StyleProp<TextStyle>;
}

async function findLatestReasoning(agent: PaseoAgent): Promise<LatestReasoning | null> {
  let page = await agent.timeline.refetch({
    direction: "tail",
    limit: TIMELINE_PAGE_LIMIT,
    projection: "projected",
  });

  for (;;) {
    for (let index = page.entries.length - 1; index >= 0; index -= 1) {
      const entry = page.entries[index];
      if (entry?.item.type === "reasoning") {
        return { timestamp: Date.parse(entry.timestamp) };
      }
    }

    if (!page.hasOlder || !page.startCursor) return null;
    page = await agent.timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: TIMELINE_PAGE_LIMIT,
      projection: "projected",
    });
  }
}

function useReasoningMode(): ReasoningDisplayMode {
  const getSettings = useRpc(getReasoningSettingsRpc);
  const { data } = useQuery({
    queryKey: reasoningSettingsQueryKey,
    queryFn: () => getSettings({}),
  });
  return data?.mode ?? DEFAULT_REASONING_DISPLAY_MODE;
}

function useIsLatestReasoning(agentId: string, timestamp: Date): boolean {
  const paseo = usePaseo();
  const agent = useMemo(() => paseo.agents.ref(agentId), [agentId, paseo]);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => getLatestReasoningQueryKey(agentId), [agentId]);
  const { data } = useQuery({
    queryKey,
    queryFn: () => findLatestReasoning(agent),
    staleTime: 250,
  });

  useEffect(() => {
    return agent.timeline.subscribe((event) => {
      if (event.event.type === "timeline") {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
  }, [agent, queryClient, queryKey]);

  if (!data) return false;
  return data.timestamp === timestamp.getTime();
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

function ThinkingBody({ text, styles }: { text: string; styles: MarkdownStyles }) {
  const scrollRef = useRef<ScrollView | null>(null);
  const isNearBottom = useRef(true);

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
      <MarkdownContent text={text} styles={styles} />
    </ScrollView>
  );
}

function useMarkdownStyles(theme: PluginTimelineItemProps["theme"]): MarkdownStyles {
  return useMemo(
    () => ({
      container: { gap: 6, paddingBottom: 10, paddingHorizontal: 13, paddingTop: 4 },
      paragraph: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      heading: { color: theme.colors.foreground, fontSize: 15, fontWeight: "700", lineHeight: 22 },
      bullet: { color: theme.colors.foregroundMuted, minWidth: 24, lineHeight: 20 },
      bulletRow: { flexDirection: "row", gap: 4, alignItems: "flex-start" },
      quote: {
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.accent,
        color: theme.colors.foregroundMuted,
        paddingLeft: 8,
        lineHeight: 20,
      },
      code: {
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        paddingHorizontal: 3,
      },
      codeBlock: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 13,
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
  const mode = useReasoningMode();
  const isLatest = useIsLatestReasoning(agentId, timestamp);
  const agentStatus = useAgent(agentId, ({ status }) => status);
  const isStreaming = agentStatus === "running" && isLatest;
  const preferredExpanded = mode === "expanded" || (mode === "expand_last" && isLatest);
  const [expanded, setExpanded] = useState(preferredExpanded || isStreaming);
  const styles = useMarkdownStyles(theme);

  useEffect(() => {
    setExpanded(getReasoningExpansionState(preferredExpanded, isStreaming));
  }, [isStreaming, preferredExpanded]);

  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const isExpanded = isStreaming || expanded;
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
      paddingVertical: 0,
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
  const labelRowStyle = useMemo(
    () => ({
      alignItems: "center" as const,
      flex: 1,
      flexDirection: "row" as const,
      overflow: "hidden" as const,
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
    () => ({ color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 }),
    [theme.colors.foregroundMuted],
  );
  const headerTitleActiveStyle = useMemo(
    () => ({ color: theme.colors.foreground }),
    [theme.colors.foreground],
  );
  const chevronStyle = useMemo(
    () => ({
      flexShrink: 0 as const,
      marginLeft: -4,
      transform: isExpanded
        ? [{ scale: 1.3 }, { rotate: "90deg" as const }]
        : [{ scale: 1.3 }],
    }),
    [isExpanded],
  );
  const detailStyle = useMemo(
    () => ({
      borderBottomLeftRadius: 8,
      borderBottomRightRadius: 8,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderTopWidth: 0,
      flexShrink: 1,
      minWidth: 0,
      overflow: "hidden" as const,
    }),
    [theme.colors.border],
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
          <View style={labelRowStyle}>
            <View style={iconBadgeStyle}>
              <Icon
                color={isExpanded ? theme.colors.foreground : theme.colors.foregroundMuted}
                name="Brain"
                size={16}
              />
            </View>
            <Text style={[headerTitleStyle, isExpanded && headerTitleActiveStyle]}>Thinking</Text>
          </View>
          <View style={chevronStyle}>
            <Icon color={theme.colors.foregroundMuted} name="ChevronRight" size={12} />
          </View>
        </View>
      </Pressable>
      {isExpanded ? (
        <View style={detailStyle}>
          <ThinkingBody text={item.data.text} styles={styles} />
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
  const mode = data?.mode ?? DEFAULT_REASONING_DISPLAY_MODE;
  const styles = useMemo<ReasoningSettingsStyles>(
    () => ({
      screen: {
        backgroundColor: theme.colors.surface0,
        flex: 1,
        gap: 16,
        padding: layout.compact ? 16 : 24,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      description: { color: theme.colors.foregroundMuted, lineHeight: 20 },
      option: {
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        padding: 14,
      },
      selectedOption: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.accent },
      optionText: { color: theme.colors.foreground, fontSize: 15 },
      selectedOptionText: { color: theme.colors.accent, fontWeight: "700" as const },
      status: { color: theme.colors.foregroundMuted },
    }),
    [layout.compact, theme],
  );
  const handleModeChange = useCallback(
    (nextMode: ReasoningDisplayMode) => mutation.mutate({ mode: nextMode }),
    [mutation],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Thinking display</Text>
      <Text style={styles.description}>
        Choose how reasoning blocks appear in the agent timeline.
      </Text>
      {DISPLAY_MODES.map((option) => {
        const selected = mode === option;
        return (
          <ReasoningModeOption
            key={option}
            disabled={isPending || mutation.isPending}
            mode={option}
            onSelect={handleModeChange}
            selected={selected}
            styles={styles}
          />
        );
      })}
      {mutation.error ? <Text style={styles.status}>{mutation.error.message}</Text> : null}
    </View>
  );
}

function ReasoningModeOption({
  disabled,
  mode,
  onSelect,
  selected,
  styles,
}: {
  disabled: boolean;
  mode: ReasoningDisplayMode;
  onSelect: (mode: ReasoningDisplayMode) => void;
  selected: boolean;
  styles: ReasoningSettingsStyles;
}) {
  const handlePress = useCallback(() => onSelect(mode), [mode, onSelect]);
  return (
    <Pressable
      accessibilityLabel={`${DISPLAY_MODE_LABELS[mode]}${selected ? ", selected" : ""}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={handlePress}
      style={selected ? styles.selectedOption : styles.option}
    >
      <Text style={selected ? styles.selectedOptionText : styles.optionText}>
        {DISPLAY_MODE_LABELS[mode]}
      </Text>
    </Pressable>
  );
}

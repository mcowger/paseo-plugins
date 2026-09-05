import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

export interface MarkdownStyles {
  readonly container: StyleProp<ViewStyle>;
  readonly paragraph: StyleProp<TextStyle>;
  readonly heading: StyleProp<TextStyle>;
  readonly bullet: StyleProp<TextStyle>;
  readonly bulletRow: StyleProp<ViewStyle>;
  readonly quote: StyleProp<TextStyle>;
  readonly code: StyleProp<TextStyle>;
  readonly codeBlock: StyleProp<TextStyle>;
  readonly spacer: StyleProp<ViewStyle>;
}

export type MarkdownVariant = "body" | "thought";

export function renderInlineMarkdown(text: string, styles: MarkdownStyles): ReactNode[] {
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
    nodes.push(<Text key={`inline-${nodeIndex}`} style={tokenStyle}>{tokenText}</Text>);
    nodeIndex += 1;
    cursor = start + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function InlineMarkdown({ text, styles }: { text: string; styles: MarkdownStyles }) {
  return <Text style={styles.paragraph}>{renderInlineMarkdown(text, styles)}</Text>;
}

export function MarkdownContent({ text, styles }: { text: string; styles: MarkdownStyles }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let codeLines: string[] | null = null;

  const addCodeBlock = (key: string, linesToAdd: string[]) => {
    blocks.push(<Text key={key} selectable style={styles.codeBlock}>{linesToAdd.join("\n")}</Text>);
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (codeLines !== null) {
      if (trimmed.startsWith("```")) {
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
    if (!trimmed) {
      blocks.push(<View key={`space-${blocks.length}`} style={styles.spacer} />);
      return;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      blocks.push(<Text key={`heading-${blocks.length}`} selectable style={styles.heading}>{renderInlineMarkdown(heading[1] ?? "", styles)}</Text>);
      return;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      blocks.push(
        <View key={`unordered-${blocks.length}`} style={styles.bulletRow}>
          <Text style={styles.bullet}>•</Text>
          <InlineMarkdown text={unordered[1] ?? ""} styles={styles} />
        </View>,
      );
      return;
    }
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      blocks.push(
        <View key={`ordered-${blocks.length}`} style={styles.bulletRow}>
          <Text style={styles.bullet}>{ordered[1]}.</Text>
          <InlineMarkdown text={ordered[2] ?? ""} styles={styles} />
        </View>,
      );
      return;
    }
    if (trimmed.startsWith(">")) {
      blocks.push(<Text key={`quote-${blocks.length}`} selectable style={styles.quote}>{renderInlineMarkdown(trimmed.slice(1).trimStart(), styles)}</Text>);
      return;
    }
    blocks.push(<InlineMarkdown key={`paragraph-${blocks.length}`} text={line} styles={styles} />);
  });

  if (codeLines !== null) addCodeBlock(`code-${blocks.length}`, codeLines);
  return <View style={styles.container}>{blocks}</View>;
}

export function MarkdownPreview({ text, styles, numberOfLines }: {
  text: string;
  styles: MarkdownStyles;
  numberOfLines: number;
}) {
  const containerStyle = useMemo(
    () => ({ maxHeight: numberOfLines * 21, overflow: "hidden" as const }),
    [numberOfLines],
  );
  return <View style={containerStyle}><MarkdownContent text={text} styles={styles} /></View>;
}

export function useMarkdownStyles(theme: PluginTheme, variant: MarkdownVariant): MarkdownStyles {
  return useMemo(() => {
    const monospace = variant === "thought" ? { fontFamily: "monospace" } : {};
    return {
      container: { gap: 6 },
      paragraph: {
        color: theme.colors.foreground,
        fontSize: 14,
        lineHeight: 21,
        ...monospace,
      },
      heading: {
        color: theme.colors.foreground,
        fontSize: 15,
        fontWeight: "700" as const,
        lineHeight: 21,
        ...monospace,
      },
      bullet: {
        color: theme.colors.accent,
        minWidth: 20,
        fontSize: 14,
        lineHeight: 21,
        ...monospace,
      },
      bulletRow: { flexDirection: "row" as const, gap: 4, alignItems: "flex-start" as const },
      quote: {
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.accent,
        color: theme.colors.foregroundMuted,
        paddingLeft: 8,
        fontSize: 14,
        lineHeight: 21,
        ...monospace,
      },
      code: {
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        paddingHorizontal: 3,
      },
      codeBlock: {
        backgroundColor: theme.colors.surface0,
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
    };
  }, [theme, variant]);
}

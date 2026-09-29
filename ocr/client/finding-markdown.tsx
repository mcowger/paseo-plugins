import { useMemo } from "react";
import { Platform, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import {
  parseFindingMarkdown,
  parseInlineFindingMarkdown,
  type FindingMarkdownBlock,
} from "../shared/markdown.js";

type Theme = PluginWorkspacePanelProps["theme"];

const MONOSPACE_FAMILY = Platform.OS === "ios" ? "Courier" : "monospace";

interface MarkdownStyles {
  body: { color: string; fontSize: number; lineHeight: number };
  strong: { color: string; fontWeight: "700" };
  emphasis: { color: string; fontStyle: "italic" };
  inlineCode: { color: string; backgroundColor: string; fontFamily: string };
  heading: { color: string; fontSize: number; fontWeight: "700" };
  bulletRow: { flexDirection: "row"; gap: number };
  bullet: { color: string };
  quote: {
    color: string;
    fontSize: number;
    lineHeight: number;
    fontStyle: "italic";
    borderLeftWidth: number;
    borderLeftColor: string;
    paddingLeft: number;
  };
  codeBlock: {
    backgroundColor: string;
    borderRadius: number;
    padding: number;
    borderLeftWidth: number;
    borderLeftColor: string;
  };
  codeText: { color: string; fontSize: number; fontFamily: string };
  spacer: { height: number };
}

function useMarkdownStyles(theme: Theme, compact: boolean, accent: string): MarkdownStyles {
  const size = compact ? 12 : 13;
  return useMemo(
    () => ({
      body: { color: theme.colors.foreground, fontSize: size, lineHeight: size + 6 },
      strong: { color: theme.colors.foreground, fontWeight: "700" },
      emphasis: { color: theme.colors.foreground, fontStyle: "italic" },
      inlineCode: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        fontFamily: MONOSPACE_FAMILY,
      },
      heading: { color: theme.colors.foreground, fontSize: size + 2, fontWeight: "700" },
      bulletRow: { flexDirection: "row", gap: 6 },
      bullet: { color: theme.colors.foregroundMuted },
      quote: {
        color: theme.colors.foregroundMuted,
        fontSize: size,
        lineHeight: size + 6,
        fontStyle: "italic",
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border,
        paddingLeft: 8,
      },
      codeBlock: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        padding: 8,
        borderLeftWidth: 3,
        borderLeftColor: accent,
      },
      codeText: { color: theme.colors.foreground, fontSize: size - 1, fontFamily: MONOSPACE_FAMILY },
      spacer: { height: 6 },
    }),
    [theme, compact, accent],
  );
}

function renderInline(text: string, styles: MarkdownStyles, keyPrefix: string): React.ReactNode[] {
  return parseInlineFindingMarkdown(text).map((part, index) => {
    const key = `${keyPrefix}-inline-${index}`;
    if (part.type === "text") return part.text;
    if (part.type === "bold") {
      return (
        <Text key={key} style={styles.strong}>
          {part.text}
        </Text>
      );
    }
    if (part.type === "italic") {
      return (
        <Text key={key} style={styles.emphasis}>
          {part.text}
        </Text>
      );
    }
    return (
      <Text key={key} style={styles.inlineCode}>
        {part.text}
      </Text>
    );
  });
}

function MarkdownCodeBlock({ code, styles }: { code: string; styles: MarkdownStyles }) {
  return (
    <View style={styles.codeBlock}>
      <Text selectable style={styles.codeText}>
        {code}
      </Text>
    </View>
  );
}

function MarkdownBlock({
  block,
  index,
  idPrefix,
  styles,
}: {
  block: FindingMarkdownBlock;
  index: number;
  idPrefix: string;
  styles: MarkdownStyles;
}) {
  const key = `${idPrefix}-block-${block.type}-${index}`;
  if (block.type === "spacer") return <View key={key} style={styles.spacer} />;
  if (block.type === "heading") {
    return (
      <Text key={key} selectable style={styles.heading}>
        {renderInline(block.text, styles, key)}
      </Text>
    );
  }
  if (block.type === "unordered") {
    return (
      <View key={key} style={styles.bulletRow}>
        <Text style={styles.bullet}>{"\u2022"}</Text>
        <Text selectable style={styles.body}>
          {renderInline(block.text, styles, key)}
        </Text>
      </View>
    );
  }
  if (block.type === "ordered") {
    return (
      <View key={key} style={styles.bulletRow}>
        <Text style={styles.bullet}>{block.marker}</Text>
        <Text selectable style={styles.body}>
          {renderInline(block.text, styles, key)}
        </Text>
      </View>
    );
  }
  if (block.type === "quote") {
    return (
      <Text key={key} selectable style={styles.quote}>
        {renderInline(block.text, styles, key)}
      </Text>
    );
  }
  if (block.type === "code") {
    return <MarkdownCodeBlock key={key} code={block.text} styles={styles} />;
  }
  return (
    <Text key={key} selectable style={styles.body}>
      {renderInline(block.text, styles, key)}
    </Text>
  );
}

export function FindingCodeBlock({
  code,
  theme,
  compact,
  accent,
}: {
  code: string;
  theme: Theme;
  compact: boolean;
  accent: string;
}) {
  const styles = useMarkdownStyles(theme, compact, accent);
  return <MarkdownCodeBlock code={code} styles={styles} />;
}

export function FindingMarkdown({
  text,
  theme,
  compact,
  accent,
  idPrefix,
}: {
  text: string;
  theme: Theme;
  compact: boolean;
  accent: string;
  idPrefix: string;
}) {
  const styles = useMarkdownStyles(theme, compact, accent);
  const blocks = useMemo(() => parseFindingMarkdown(text), [text]);
  return (
    <View style={{ gap: 2 }}>
      {blocks.map((block, index) => (
        <MarkdownBlock
          key={`${idPrefix}-${index}`}
          block={block}
          index={index}
          idPrefix={idPrefix}
          styles={styles}
        />
      ))}
    </View>
  );
}

export function SeverityBadgeIcon({ name, color }: { name: string; color: string }) {
  return <Icon name={name} color={color} size={12} />;
}

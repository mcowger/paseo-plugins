import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React, { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { PaseoCodeBlock, Section } from "./paseo";
import { parseCodeModeCatalog } from "../shared/codemode";
import { compactText, formatUnknownValue } from "../shared/presentation";

type Theme = PluginTimelineItemProps["theme"];

const VISIBLE_CATALOG_ITEMS = 8;

function catalogTitle(path: string): string {
  const normalized = path.replace(/^tools\./, "");
  const leaf = normalized.split(".").at(-1) ?? normalized;
  const words = leaf.replace(/[_-]+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return normalized;
  return words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

function catalogServer(path: string): string {
  const normalized = path.replace(/^tools\./, "");
  const segments = normalized.split(".");
  return segments.length > 1 ? (segments[0] ?? normalized) : normalized;
}

export function CodeModeToolDetail({
  code,
  output,
  theme,
  styles,
}: {
  code: string;
  output: unknown;
  theme: Theme;
  styles: ActivityStyles;
}) {
  const catalog = useMemo(() => parseCodeModeCatalog(output), [output]);
  const [showAll, setShowAll] = useState(false);
  const visibleItems = catalog && !showAll ? catalog.items.slice(0, VISIBLE_CATALOG_ITEMS) : catalog?.items;
  const hiddenCount = catalog ? catalog.items.length - (visibleItems?.length ?? 0) : 0;
  const totalHint = catalog?.remaining !== undefined ? ` · ${catalog.remaining} more in catalog` : "";

  return (
    <View style={styles.paseoStack}>
      <PaseoCodeBlock code={code} language="javascript" label="Script" theme={theme} styles={styles} />
      {catalog && visibleItems ? (
        <Section title={`Tools (${catalog.items.length}${totalHint})`} styles={styles}>
          <View style={styles.paseoList}>
            {visibleItems.map((item) => (
              <View key={item.path} style={styles.paseoListItem}>
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {catalogTitle(item.path)}
                  </Text>
                  <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                    {catalogServer(item.path)}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                  {item.path}
                </Text>
                {item.description ? (
                  <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                    {compactText(item.description, 180)}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
          {hiddenCount > 0 || catalog.remaining ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowAll(!showAll)}
              style={styles.showMoreButton}
            >
              <Text style={styles.showMoreText}>
                {showAll
                  ? "Show less"
                  : `Show all (${catalog.items.length} listed${catalog.remaining ? `, ${catalog.remaining} more` : ""})`}
              </Text>
            </Pressable>
          ) : null}
        </Section>
      ) : (
        <PaseoCodeBlock
          code={formatUnknownValue(output)}
          language="json"
          label="Output"
          theme={theme}
          styles={styles}
        />
      )}
    </View>
  );
}

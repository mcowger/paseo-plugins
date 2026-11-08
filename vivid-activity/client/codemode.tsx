import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React, { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { aria } from "./kit";
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

  return (
    <View style={styles.paseoStack}>
      <PaseoCodeBlock code={code} language="javascript" label={t("ui.script")} theme={theme} styles={styles} />
      {catalog && visibleItems ? (
        <Section title={catalog.remaining !== undefined ? t("ui.toolsRemaining", { count: catalog.items.length, remaining: catalog.remaining }) : t("ui.toolsCount", { count: catalog.items.length })} styles={styles}>
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
              {...aria({ expanded: showAll })}
              onPress={() => setShowAll(!showAll)}
              style={styles.showMoreButton}
            >
              <Text style={styles.showMoreText}>
                {showAll
                  ? t("ui.collapse")
                  : catalog.remaining ? t("ui.expandToolsRemaining", { count: catalog.items.length, remaining: catalog.remaining }) : t("ui.expandToolsCount", { count: catalog.items.length })}
              </Text>
            </Pressable>
          ) : null}
        </Section>
      ) : (
        <PaseoCodeBlock
          code={formatUnknownValue(output)}
          language="json"
          label={t("ui.output")}
          theme={theme}
          styles={styles}
        />
      )}
    </View>
  );
}

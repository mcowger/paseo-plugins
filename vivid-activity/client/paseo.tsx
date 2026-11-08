import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useWrapLines } from "./settings-hooks";
import { extractPaseoChildAgentId } from "../shared/child-agent";
import { instantParts, instantText, isInstantString } from "../shared/clock";
import { exaOutputText, exaToolKind, exaToolSummary, parseExaSearchResults, type ExaSearchResult, } from "../shared/exa";
import { formatUnknownValue, notInHeader, outputView, paseoToolLeafName, paseoToolResult, paseoToolSummary, stripAnsi, type ActivityPalette, } from "../shared/presentation";
import { statusLabel } from "../shared/vivid-model";
import type { ActivityStyles } from "./activity";
import { ChildAgentTimeline } from "./child-agent";
import { OutputCopyButtons } from "./copy-button";
import { useHighlightTokens, type HighlightToken } from "./highlight";
import { aria } from "./kit";
import { StatusPill, statusColor } from "./status-pill";
import { useForeground } from "./use-foreground";
export { StatusPill } from "./status-pill";

type Theme = PluginTimelineItemProps["theme"];
type JsonRecord = Record<string, unknown>;

type PaseoProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fieldString(
  record: JsonRecord | null,
  key: string
): string | undefined {
  return stringValue(record?.[key]);
}

function fieldNumber(
  record: JsonRecord | null,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function fieldBoolean(
  record: JsonRecord | null,
  key: string
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function fieldArray(record: JsonRecord | null, key: string): unknown[] {
  return Array.isArray(record?.[key]) ? (record[key] as unknown[]) : [];
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? t("ui.yes") : t("ui.no");
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return formatUnknownValue(value);
}

function stableItemKey(value: unknown, prefix: string): string {
  const record = asRecord(value);
  const identity =
    record?.id ?? record?.agentId ?? record?.workspaceId ?? record?.browserId;
  if (typeof identity === "string" || typeof identity === "number") {
    return `${prefix}-${identity}`;
  }
  try {
    return `${prefix}-${JSON.stringify(value)}`;
  } catch {
    return prefix;
  }
}

export function Section({
  title,
  children,
  styles,
}: {
  title: string;
  children: ReactNode;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.detailLabel}>{title}</Text>
      {children}
    </View>
  );
}

// 本地补丁（0.6.0，opus-F49）：原生端（Yoga）的 Text 默认不收缩，放在 row 里长了就溢出、被裁掉。
/** A row child that takes the rest of the row (main axis = width, so `flex: 1` is safe here). */
const ROW_FILL: ViewStyle = { flex: 1, minWidth: 0 };
/** Secondary words after a list row's title: they may wrap, and never take more than 60% of the row from the title. */
const ROW_TAIL: TextStyle = { flexShrink: 1, maxWidth: "60%" };

// 本地补丁（0.6.0，opus-F53）：时间里的「9 小时后」按分钟刷新。显示中的时间共用一个 60 秒定时器：App 在后台时不订阅，
// 没有订阅者就停；停着时读到的「现在」旧了一分钟以上就当场换新，展开一行时不会先闪一下过时的相对时间。
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
let minuteNow = Date.now();
function subscribeMinute(listener: () => void): () => void {
  minuteListeners.add(listener);
  if (minuteTimer === null) {
    minuteTimer = setInterval(() => {
      minuteNow = Date.now();
      for (const each of minuteListeners) each();
    }, 60_000);
  }
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== null) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}
const idleMinute = () => () => {};
function readMinute(): number {
  if (minuteTimer === null && Date.now() - minuteNow >= 60_000) minuteNow = Date.now();
  return minuteNow;
}
/** The time now, refreshed every minute while the app is in the foreground. */
function useMinuteNow(): number {
  const foreground = useForeground();
  return useSyncExternalStore(foreground ? subscribeMinute : idleMinute, readMinute, readMinute);
}

/**
 * 本地补丁（0.6.0，opus-F53）：严格的 ISO-8601 时刻（daemon 写的 `2026-10-13T00:00:00.000Z` 这类 UTC 串）按设备时区显示成
 * 「明天 05:00（9 小时后）」，规则见 shared/clock.ts；将来的相对时间用运行中的蓝色，过去的用次要色。
 * 原文不丢：点一下换成原文，再点换回；读屏念的名称里两者都有。不是严格时刻的值原样显示。
 * 按下区是一个 row，里面的 Text 收缩折行；放进 row 里时由 `containerStyle` 给出它在 row 里的伸缩。
 */
function InstantText({
  value,
  prefix = "",
  style,
  containerStyle,
  palette,
  styles,
}: {
  value: string;
  /** Words before the time, e.g. 「0 9 * * * · 下次运行 」. */
  prefix?: string;
  style: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const now = useMinuteNow();
  const [raw, setRaw] = useState(false);
  const parts = instantParts(value, now);
  if (!parts) {
    return (
      <Text selectable style={style}>
        {`${prefix}${value}`}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("ui.original", { prefix: prefix, time: instantText(value, now), value: value })}
      accessibilityState={{ selected: raw }}
      {...aria({ pressed: raw })}
      onPress={() => setRaw((current) => !current)}
      style={[{ flexDirection: "row" }, containerStyle]}
    >
      <Text selectable style={[style, { flexShrink: 1, minWidth: 0 }]}>
        {raw ? `${prefix}${value}` : t("ui.clockLine", { prefix, day: parts.day, clock: parts.clock })}
        {!raw && parts.relative ? (
          <Text style={{ color: parts.future ? palette.statusColors.running : styles.mutedText.color }}>
            {t("ui.relativeSuffix", { relative: parts.relative })}
          </Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

/** One scalar field value: strict ISO-8601 instants read in the device's zone (`InstantText`), the rest as text. */
function ScalarValue({
  value,
  palette,
  styles,
}: {
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (isInstantString(value)) {
    return <InstantText value={value} style={styles.paseoValue} palette={palette} styles={styles} />;
  }
  return (
    <Text selectable style={styles.paseoValue}>
      {scalarText(value)}
    </Text>
  );
}

function PaseoFieldValue({
  value,
  palette,
  styles,
  depth = 0,
}: {
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
  depth?: number;
}) {
  if (depth > 2) return <ScalarValue value={value} palette={palette} styles={styles} />;
  const record = asRecord(value);
  if (record) {
    const entries = Object.entries(record).filter(
      ([, child]) => child !== undefined
    );
    if (entries.length === 0) return <Text style={styles.paseoValue}>—</Text>;
    return (
      <View style={styles.paseoRows}>
        {entries.map(([key, child]) => (
          <PaseoField
            key={`${key}-${stableItemKey(child, key)}`}
            label={humanizeKey(key)}
            value={child}
            palette={palette}
            styles={styles}
            depth={depth + 1}
          />
        ))}
      </View>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={styles.paseoValue}>—</Text>;
    return (
      <View style={styles.paseoRows}>
        {value.map((child) => (
          <PaseoFieldValue
            key={stableItemKey(child, "item")}
            value={child}
            palette={palette}
            styles={styles}
            depth={depth + 1}
          />
        ))}
      </View>
    );
  }
  return <ScalarValue value={value} palette={palette} styles={styles} />;
}

function PaseoField({
  label,
  value,
  palette,
  styles,
  depth = 0,
}: {
  label: string;
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
  depth?: number;
}) {
  return (
    <View style={styles.paseoRow}>
      <Text style={styles.paseoKey}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <PaseoFieldValue
          value={value}
          palette={palette}
          styles={styles}
          depth={depth}
        />
      </View>
    </View>
  );
}

const STATUS_FIELDS: ReadonlySet<string> = new Set(["status", "attentionReason"]);

export function PaseoFields({
  fields,
  palette,
  styles,
}: {
  fields: Array<[string, unknown, string?]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  // 本地补丁：状态类字段的值（idle、running、paused…）显示中文；其他字段值是数据，原样显示。
  const visible = fields
    .filter(([, value]) => value !== undefined)
    .map(([label, value, id]) => [label, id && STATUS_FIELDS.has(id) && typeof value === "string" ? statusLabel(value) : value, id] as [string, unknown, string?]);
  if (visible.length === 0) return null;
  return (
    <View style={styles.paseoRows}>
      {visible.map(([label, value, id], index) => (
        <PaseoField
          key={`${id ?? index}-${stableItemKey(value, id ?? String(index))}`}
          label={label}
          value={value}
          palette={palette}
          styles={styles}
        />
      ))}
    </View>
  );
}

/** Field value with header-duplicate scalars removed (see `notInHeader`). */
function unlessInHeader(value: unknown, headerSummary: string | undefined): unknown {
  return typeof value === "string" || typeof value === "number"
    ? notInHeader(value, headerSummary)
    : value;
}

/** One muted line of secondary facts, joined with middots. */
function MetaLine({ parts, styles }: { parts: Array<string | undefined>; styles: ActivityStyles }) {
  const text = parts.filter(Boolean).join(t("ui.metaSeparator"));
  if (!text) return null;
  return (
    <Text numberOfLines={2} style={styles.paseoHeroSubtitle}>
      {text}
    </Text>
  );
}

/** A titled field list that disappears when every field is already shown elsewhere. */
export function FieldsSection({
  title,
  fields,
  palette,
  styles,
}: {
  title: string;
  fields: Array<[string, unknown, string?]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (fields.every(([, value]) => value === undefined)) return null;
  return (
    <Section title={title} styles={styles}>
      <PaseoFields fields={fields} palette={palette} styles={styles} />
    </Section>
  );
}

export function PaseoHero({
  icon,
  title,
  subtitle,
  status,
  palette,
  color,
  styles,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  status?: string;
  palette?: ActivityPalette;
  color: string;
  styles: ActivityStyles;
}) {
  return (
    <View style={[styles.paseoHero, { borderLeftColor: color }]}>
      <View style={styles.paseoHeroRow}>
        <View style={styles.paseoHeroIcon}>
          <Icon name={icon} color={color} size={12} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.paseoHeroTitle}>{title}</Text>
          {subtitle || status ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {subtitle ? (
                <Text numberOfLines={1} style={styles.paseoHeroSubtitle}>
                  {subtitle}
                </Text>
              ) : null}
              {status && palette ? (
                <Text
                  numberOfLines={1}
                  style={[styles.paseoHeroSubtitle, { color: statusColor(status, palette) }]}
                >
                  {status}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function PromptBlock({
  text,
  label = t("ui.prompt"),
  styles,
  compact = false,
}: {
  text: string | undefined;
  label?: string;
  styles: ActivityStyles;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const prompt = compact ? (
    <Pressable
      accessibilityLabel={expanded ? t("ui.collapsePrompt", { text }) : t("ui.expandPrompt", { text })}
      accessibilityRole="button"
      {...aria({ expanded })}
      onPress={() => setExpanded((current) => !current)}
    >
      <Text numberOfLines={expanded ? undefined : 2} selectable style={styles.paseoPrompt}>
        {text}
      </Text>
    </Pressable>
  ) : (
    <Text selectable style={styles.paseoPrompt}>
      {text}
    </Text>
  );
  return label ? <Section title={label} styles={styles}>{prompt}</Section> : prompt;
}

function TokenizedLines({
  lines,
  styles,
  wrapLines: wrap,
}: {
  lines: HighlightToken[][];
  styles: ActivityStyles;
  wrapLines?: boolean;
}) {
  return (
    <View>
      {lines.map((line, lineIndex) => (
        <Text key={`line-${lineIndex}`} selectable style={[styles.codeLine, wrap ? { flexShrink: 1 } : null]}>
          {line.length === 0
            ? " "
            : line.map((token, tokenIndex) => {
                const tokenStyle: TextStyle = {
                  color: token.color ?? styles.codeLine.color,
                  ...(token.fontStyle && token.fontStyle & 1
                    ? { fontStyle: "italic" }
                    : {}),
                  ...(token.fontStyle && token.fontStyle & 2
                    ? { fontWeight: "700" }
                    : {}),
                  ...(token.fontStyle && token.fontStyle & 4
                    ? { textDecorationLine: "underline" }
                    : {}),
                };
                return (
                  <Text key={`${lineIndex}-${tokenIndex}`} style={tokenStyle}>
                    {token.content}
                  </Text>
                );
              })}
        </Text>
      ))}
    </View>
  );
}

export function PaseoCodeBlock({
  code,
  language,
  label,
  theme,
  styles,
}: {
  code: string;
  language: string;
  label?: string;
  theme: Theme;
  styles: ActivityStyles;
}) {
  const [showAll, setShowAll] = useState(false);
  // 0.5.0: terminal escape sequences (logs, terminal captures) never show; the copy buttons sit next to the label.
  const clean = useMemo(() => stripAnsi(code), [code]);
  const view = useMemo(() => outputView(code, clean, showAll, language === "ansi", false), [clean, code, language, showAll]);
  const { preview, shown: displayCode } = view;
  const tokens = useHighlightTokens(
    view.highlight,
    language,
    theme.colors,
  );
  // 0.11.0:「长行折行·代码与文件」：exa/github/codemode 等工具详情的代码块随矩阵折行。
  const wrap = useWrapLines("code");
  const title = label ?? t("ui.output");
  return (
    <View style={styles.section}>
      <View style={styles.codeHeader}>
        <Text style={[styles.detailLabel, { flexShrink: 1 }]}>{title}</Text>
        <OutputCopyButtons clean={clean} raw={code} label={t("ui.copy", { label: title })} theme={theme} styles={styles} />
      </View>
      {wrap ? (
        <View style={[styles.codeSurface, { minWidth: 0, width: "100%" }]}>
          {tokens ? (
            <TokenizedLines lines={tokens} styles={styles} wrapLines />
          ) : (
            <Text selectable style={[styles.codeLine, { flexShrink: 1 }]}>
              {displayCode || " "}
            </Text>
          )}
        </View>
      ) : (
        <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
          <View style={styles.codeSurface}>
            {tokens ? (
              <TokenizedLines lines={tokens} styles={styles} />
            ) : (
              <Text selectable style={styles.codeLine}>
                {displayCode || " "}
              </Text>
            )}
          </View>
        </ScrollView>
      )}
      {preview.truncated ? (
        <Pressable
          accessibilityRole="button"
          {...aria({ expanded: showAll })}
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll
              ? t("ui.collapse")
              : t("ui.expandAllLinesCharacters", { lines: preview.totalLines, characters: preview.totalChars.toLocaleString() })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function OutputFields({
  result,
  fields,
  palette,
  styles,
}: {
  result: JsonRecord | null;
  fields: Array<[string, string]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const values = fields.map(
    ([key, label]) => [label, result?.[key], key] as [string, unknown, string?]
  );
  if (values.every(([, value]) => value === undefined)) return null;
  return (
    <Section title={t("ui.result")} styles={styles}>
      <PaseoFields fields={values} palette={palette} styles={styles} />
    </Section>
  );
}

function ActionResult({
  result,
  palette,
  styles,
  fields = [],
}: {
  result: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
  fields?: Array<[string, string]>;
}) {
  const visibleFields = fields
    .map(([key, label]) => [label, result?.[key], key] as [string, unknown, string?])
    .filter(([, value]) => value !== undefined);
  const success = result?.success;
  if (typeof success !== "boolean" && visibleFields.length === 0) return null;
  return (
    <Section title={t("ui.result")} styles={styles}>
      <View style={styles.paseoRows}>
        {typeof success === "boolean" ? (
          <StatusPill
            value={success ? "Success" : "Failed"}
            palette={palette}
            styles={styles}
          />
        ) : null}
        <PaseoFields fields={visibleFields} palette={palette} styles={styles} />
      </View>
    </Section>
  );
}

function AgentSnapshot({
  snapshot,
  headerSummary,
  palette,
  styles,
}: {
  snapshot: JsonRecord | null;
  headerSummary: string | undefined;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (!snapshot) return null;
  const capabilities = asRecord(snapshot.capabilities);
  const modes = fieldArray(snapshot, "availableModes");
  const permissions = fieldArray(snapshot, "pendingPermissions");
  return (
    <View style={styles.paseoStack}>
      <PaseoFields
        fields={[
          [t("ui.agent"), unlessInHeader(snapshot.id, headerSummary)],
          [t("ui.title"), snapshot.title],
          [t("ui.provider"), snapshot.provider],
          [t("ui.model"), snapshot.model],
          [t("ui.status"), snapshot.status, "status"],
          [t("ui.workingDirectory"), snapshot.cwd],
          [t("ui.workspace"), snapshot.workspaceId],
          [t("ui.mode"), snapshot.currentModeId],
          [
            t("ui.thinkingLevel"),
            snapshot.effectiveThinkingOptionId ?? snapshot.thinkingOptionId,
          ],
          [t("ui.needsAttention"), snapshot.attentionReason, "attentionReason"],
          [t("ui.latestError"), snapshot.lastError],
        ]}
        palette={palette}
        styles={styles}
      />
      {capabilities ? (
        <Section title={t("ui.capabilities")} styles={styles}>
          <View style={styles.paseoChips}>
            {Object.entries(capabilities)
              .filter(([, value]) => value === true)
              .map(([key]) => (
                <View key={key} style={styles.paseoChip}>
                  <Text style={styles.paseoChipText}>{humanizeKey(key)}</Text>
                </View>
              ))}
          </View>
        </Section>
      ) : null}
      {modes.length > 0 ? (
        <ModeList modes={modes} palette={palette} styles={styles} />
      ) : null}
      {permissions.length > 0 ? (
        <Section
          title={t("ui.pendingApprovals", { count: permissions.length })}
          styles={styles}
        >
          <PermissionList
            permissions={permissions}
            palette={palette}
            styles={styles}
          />
        </Section>
      ) : null}
    </View>
  );
}

function ModeList({
  modes,
  palette,
  styles,
}: {
  modes: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (modes.length === 0) return null;
  return (
    <Section title={t("ui.availableModes")} styles={styles}>
      <View style={styles.paseoList}>
        {modes.map((mode) => {
          const record = asRecord(mode);
          return (
            <View
              key={stableItemKey(mode, "mode")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    t("ui.mode")}
                </Text>
                {fieldString(record, "id") ? (
                  <Text
                    style={[
                      styles.paseoListItemMeta,
                      ROW_TAIL,
                      { color: palette.categoryColors.agent },
                    ]}
                  >
                    {fieldString(record, "id")}
                  </Text>
                ) : null}
              </View>
              {fieldString(record, "description") ? (
                <Text style={styles.paseoListItemMeta}>
                  {fieldString(record, "description")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function PermissionList({
  permissions,
  palette,
  styles,
}: {
  permissions: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (permissions.length === 0) return <Text style={styles.empty}>{t("ui.noPendingApprovals")}</Text>;
  return (
    <View style={styles.paseoList}>
      {permissions.map((permission) => {
        const record = asRecord(permission);
        const actions = fieldArray(record, "actions");
        return (
          <View
            key={stableItemKey(permission, "permission")}
            style={styles.paseoListItem}
          >
            <View style={styles.paseoListItemHeader}>
              <Text style={styles.paseoListItemTitle}>
                {fieldString(record, "title") ??
                  fieldString(record, "name") ??
                  t("ui.permissionRequest")}
              </Text>
              {fieldString(record, "kind") ? (
                <StatusPill
                  value={fieldString(record, "kind")!}
                  palette={palette}
                  styles={styles}
                />
              ) : null}
            </View>
            {fieldString(record, "description") ? (
              <Text selectable style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
            ) : null}
            {actions.length > 0 ? (
              <Text style={styles.paseoListItemMeta}>
                {t("ui.availableActionsValue", { actions: actions
                  .map(
                    (action) =>
                      fieldString(asRecord(action), "label") ?? t("ui.action")
                  )
                  .join(t("ui.metaSeparator")) })}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function AgentTool({
  leaf,
  headerSummary,
  input,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "create_agent": {
      const childAgentId = extractPaseoChildAgentId(outputRecord);
      // Paseo 0.13: the host the child was created on (this one, or a connected host the parent chose).
      const childServerId = fieldString(outputRecord, "serverId");
      const provider = fieldString(inputRecord, "provider");
      const settings = asRecord(inputRecord?.settings);
      const thinkingOptionId = fieldString(settings, "thinkingOptionId");
      return (
        <View style={styles.paseoStack}>
          <MetaLine
            parts={[
              notInHeader(fieldString(inputRecord, "title"), headerSummary),
              notInHeader(provider, headerSummary),
              thinkingOptionId ? t("ui.thinkingLevel2", { level: thinkingOptionId }) : undefined,
              inputRecord?.background === true ? t("ui.runInBackground") : undefined,
              inputRecord?.notifyOnFinish === true ? t("ui.notifyOnCompletion") : undefined,
              fieldString(outputRecord, "status") ? statusLabel(fieldString(outputRecord, "status")!) : undefined,
            ]}
            styles={styles}
          />
          <PromptBlock
            text={fieldString(inputRecord, "initialPrompt")}
            label=""
            compact
            styles={styles}
          />
          {childAgentId ? (
            <ChildAgentTimeline
              agentId={childAgentId}
              serverId={childServerId}
              theme={theme}
              palette={palette}
              styles={styles}
            />
          ) : null}
        </View>
      );
    }
    case "send_agent_prompt":
      return (
        <View style={styles.paseoStack}>
          <PromptBlock
            text={fieldString(inputRecord, "prompt")}
            styles={styles}
          />
          <FieldsSection
            title={t("ui.sendMode")}
            fields={[
              [t("ui.agent"), unlessInHeader(inputRecord?.agentId, headerSummary)],
              [t("ui.sessionMode"), inputRecord?.sessionMode],
              [t("ui.runInBackground"), inputRecord?.background],
              [t("ui.notifyOnCompletion"), inputRecord?.notifyOnFinish],
            ]}
            palette={palette}
            styles={styles}
          />
          <OutputFields
            result={outputRecord}
            fields={[
              ["status", t("ui.status")],
              ["lastMessage", t("ui.lastMessage")],
              ["guidance", t("ui.hint")],
            ]}
            palette={palette}
            styles={styles}
          />
          {outputRecord?.permission ? (
            <Section title={t("ui.permission")} styles={styles}>
              <PermissionList
                permissions={[outputRecord.permission]}
                palette={palette}
                styles={styles}
              />
            </Section>
          ) : null}
        </View>
      );
    case "get_agent_status":
      return (
        <View style={styles.paseoStack}>
          <AgentSnapshot
            snapshot={asRecord(outputRecord?.snapshot) ?? outputRecord}
            headerSummary={headerSummary}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_agents":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.workingDirectory"), inputRecord?.cwd],
              [t("ui.statusFilter"), inputRecord?.statuses],
              [t("ui.recentHours"), inputRecord?.sinceHours],
              [t("ui.limit"), inputRecord?.limit],
              [t("ui.includeArchived"), inputRecord?.includeArchived],
            ]}
            palette={palette}
            styles={styles}
          />
          <AgentList
            agents={fieldArray(outputRecord, "agents")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "get_agent_activity":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.agent"), unlessInHeader(inputRecord?.agentId, headerSummary)],
              [t("ui.limit"), inputRecord?.limit],
              [t("ui.mode"), outputRecord?.currentModeId],
              [t("ui.updates"), outputRecord?.updateCount],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(outputRecord, "content") ? (
            <PaseoCodeBlock
              code={fieldString(outputRecord, "content")!}
              language="markdown"
              label={t("ui.activity")}
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    case "set_agent_mode":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.agent"), unlessInHeader(inputRecord?.agentId, headerSummary)],
              [t("ui.mode"), inputRecord?.modeId],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            fields={
              outputRecord?.newMode !== undefined && outputRecord.newMode !== inputRecord?.modeId
                ? [["newMode", t("ui.newMode")]]
                : []
            }
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "update_agent":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.agent"), unlessInHeader(inputRecord?.agentId, headerSummary)],
              [t("ui.name"), inputRecord?.name],
              [t("ui.labels"), inputRecord?.labels],
              [t("ui.settings"), inputRecord?.settings],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "cancel_agent":
    case "archive_agent":
    case "kill_agent":
      return (
        <View style={styles.paseoStack}>
          {notInHeader(fieldString(inputRecord, "agentId"), headerSummary) ? (
            <PaseoFields
              fields={[[t("ui.agent"), inputRecord?.agentId]]}
              palette={palette}
              styles={styles}
            />
          ) : null}
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_pending_permissions":
      return (
        <View style={styles.paseoStack}>
          <PermissionList
            permissions={fieldArray(outputRecord, "permissions")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "respond_to_permission":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.agent"), inputRecord?.agentId],
              [t("ui.request"), inputRecord?.requestId],
              [t("ui.reply"), inputRecord?.response],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function AgentList({
  agents,
  palette,
  styles,
}: {
  agents: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <Section title={t("ui.agentsCount", { count: agents.length })} styles={styles}>
      {agents.length === 0 ? (
        <Text style={styles.empty}>{t("ui.noAgentsReturned")}</Text>
      ) : (
        <View style={styles.paseoList}>
          {agents.map((agent) => {
            const record = asRecord(agent);
            return (
              <View
                key={stableItemKey(agent, "agent")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {fieldString(record, "title") ??
                      fieldString(record, "shortId") ??
                      fieldString(record, "id") ??
                      t("ui.agent")}
                  </Text>
                  {fieldString(record, "status") ? (
                    <StatusPill
                      value={fieldString(record, "status")!}
                      palette={palette}
                      styles={styles}
                    />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                  {[
                    fieldString(record, "provider"),
                    fieldString(record, "model"),
                  ]
                    .filter(Boolean)
                    .join(t("ui.metaSeparator"))}
                </Text>
                <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                  {fieldString(record, "cwd") ?? fieldString(record, "id")}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </Section>
  );
}

function WorkspaceSummary({
  result,
  palette,
  styles,
}: {
  result: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <OutputFields
      result={result}
      fields={[
        ["workspaceId", t("ui.workspace")],
        ["projectId", t("ui.project")],
        ["cwd", t("ui.workingDirectory")],
        ["isolation", t("ui.isolation")],
        ["kind", t("ui.type")],
        ["title", t("ui.title")],
      ]}
      palette={palette}
      styles={styles}
    />
  );
}

function WorkspaceTool({
  leaf,
  headerSummary,
  input,
  result,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output" | "theme"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "create_workspace":
      return (
        <View style={styles.paseoStack}>
          <Section title={t("ui.configuration")} styles={styles}>
            <PaseoFields
              fields={[
                [t("ui.title"), unlessInHeader(inputRecord?.title, headerSummary)],
                [t("ui.isolation"), inputRecord?.isolation],
                [t("ui.path2"), inputRecord?.path],
                [t("ui.project"), inputRecord?.projectId],
                [t("ui.mode"), inputRecord?.mode],
                [t("ui.worktree"), inputRecord?.worktreeSlug],
                [t("ui.branch2"), inputRecord?.branchName ?? inputRecord?.branch],
                [t("ui.baseBranch"), inputRecord?.baseBranch],
                [t("ui.mergeRequest"), inputRecord?.prNumber],
                [t("ui.forge"), inputRecord?.forge],
              ]}
              palette={palette}
              styles={styles}
            />
          </Section>
          <WorkspaceSummary
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_workspaces":
      return (
        <WorkspaceList
          workspaces={fieldArray(outputRecord, "workspaces")}
          palette={palette}
          styles={styles}
        />
      );
    case "archive_workspace":
      return (
        <View style={styles.paseoStack}>
          <ActionResult
            result={outputRecord}
            fields={[
              ...(notInHeader(fieldString(outputRecord, "workspaceId"), headerSummary)
                ? ([["workspaceId", t("ui.workspace")]] as Array<[string, string]>)
                : []),
              ["archivedAgentIds", t("ui.archivedAgents")],
              ["removedDirectory", t("ui.removedDirectory")],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "rename_workspace":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.workspace"), unlessInHeader(inputRecord?.workspaceId, headerSummary)],
              [t("ui.newTitle"), inputRecord?.title],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            fields={[
              ["workspaceId", t("ui.workspace")],
              ["title", t("ui.title")],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function WorkspaceList({
  workspaces,
  palette,
  styles,
}: {
  workspaces: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (workspaces.length === 0) {
    return <Text style={styles.empty}>{t("ui.noWorkspacesReturned")}</Text>;
  }
  return (
    <Section title={t("ui.workspaces", { count: workspaces.length })} styles={styles}>
      <View style={styles.paseoList}>
        {workspaces.map((workspace) => {
          const record = asRecord(workspace);
          return (
            <View
              key={stableItemKey(workspace, "workspace")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "title") ??
                    fieldString(record, "workspaceId") ??
                    t("ui.workspace")}
                </Text>
                {fieldString(record, "isolation") ? (
                  <StatusPill
                    value={fieldString(record, "isolation")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "cwd")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "workspaceId")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ScriptList({
  scripts,
  palette,
  styles,
}: {
  scripts: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (scripts.length === 0) {
    return <Text style={styles.empty}>{t("ui.noWorkspaceScriptsReturned")}</Text>;
  }
  return (
    <Section title={t("ui.scripts", { count: scripts.length })} styles={styles}>
      <View style={styles.paseoList}>
        {scripts.map((script) => {
          const record = asRecord(script);
          return (
            <View
              key={stableItemKey(script, "script")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "scriptName") ?? t("ui.script")}
                </Text>
                {fieldString(record, "lifecycle") ? (
                  <StatusPill
                    value={fieldString(record, "lifecycle")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {[
                  fieldString(record, "type"),
                  fieldString(record, "health"),
                  fieldString(record, "port"),
                ]
                  .filter(Boolean)
                  .join(t("ui.metaSeparator"))}
              </Text>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "proxyUrl") ??
                  fieldString(record, "localProxyUrl")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function TerminalList({
  terminals,
  palette,
  styles,
}: {
  terminals: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (terminals.length === 0) {
    return <Text style={styles.empty}>{t("ui.noTerminalsReturned")}</Text>;
  }
  return (
    <Section title={t("ui.terminals", { count: terminals.length })} styles={styles}>
      <View style={styles.paseoList}>
        {terminals.map((terminal) => {
          const record = asRecord(terminal);
          return (
            <View
              key={stableItemKey(terminal, "terminal")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    t("ui.terminal")}
                </Text>
                <Icon
                  name="SquareTerminal"
                  color={palette.categoryColors.shell}
                  size={12}
                />
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "cwd")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function TerminalTool({
  leaf,
  input,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "list_workspace_scripts":
    case "start_workspace_script":
    case "stop_workspace_script": {
      const scriptResult = asRecord(result)?.script ?? result;
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.workspace"), inputRecord?.workspaceId],
              [t("ui.script"), inputRecord?.scriptName],
            ]}
            palette={palette}
            styles={styles}
          />
          {leaf === "list_workspace_scripts" ? (
            <ScriptList
              scripts={fieldArray(outputRecord, "scripts")}
              palette={palette}
              styles={styles}
            />
          ) : (
            <Section title={t("ui.script")} styles={styles}>
              <ScriptList
                scripts={[scriptResult]}
                palette={palette}
                styles={styles}
              />
            </Section>
          )}
        </View>
      );
    }
    case "list_terminals":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.workingDirectory"), inputRecord?.cwd],
              [t("ui.allDirectories"), inputRecord?.all],
            ]}
            palette={palette}
            styles={styles}
          />
          <TerminalList
            terminals={fieldArray(outputRecord, "terminals")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "create_terminal":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.workingDirectory"), inputRecord?.cwd],
              [t("ui.workspace"), inputRecord?.workspaceId],
              [t("ui.name"), inputRecord?.name],
            ]}
            palette={palette}
            styles={styles}
          />
          <Section title={t("ui.terminal")} styles={styles}>
            <TerminalList
              terminals={[result]}
              palette={palette}
              styles={styles}
            />
          </Section>
        </View>
      );
    case "capture_terminal": {
      const lines = fieldArray(outputRecord, "lines")
        .map(scalarText)
        .join("\n");
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.terminal"), inputRecord?.terminalId],
              [t("ui.startLine"), inputRecord?.start],
              [t("ui.endLine"), inputRecord?.end],
              [t("ui.scrollbackLines"), inputRecord?.scrollback],
              [t("ui.stripColorCodes"), inputRecord?.stripAnsi],
              [t("ui.totalLines"), outputRecord?.totalLines],
            ]}
            palette={palette}
            styles={styles}
          />
          {lines ? (
            <PaseoCodeBlock
              code={lines}
              language="ansi"
              label={t("ui.terminalOutput")}
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    }
    case "send_terminal_keys":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.terminal"), inputRecord?.terminalId],
              [t("ui.keys"), inputRecord?.keys],
              [t("ui.sendLiterally"), inputRecord?.literal],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "kill_terminal":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="CircleX"
            title={fieldString(inputRecord, "terminalId") ?? t("ui.terminal")}
            color={palette.categoryColors.shell}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function ScheduleTool({
  leaf,
  headerSummary,
  input,
  result,
  theme: _theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  const isMutation = [
    "delete_heartbeat",
    "pause_schedule",
    "resume_schedule",
    "delete_schedule",
  ].includes(leaf);
  if (isMutation) {
    return (
      <View style={styles.paseoStack}>
        <PaseoHero
          icon={
            leaf.startsWith("delete")
              ? "Trash2"
              : leaf === "pause_schedule"
              ? "Pause"
              : "Play"
          }
          title={fieldString(inputRecord, "id") ?? t("ui.schedule")}
          color={palette.categoryColors.plan}
          styles={styles}
        />
        <ActionResult result={outputRecord} palette={palette} styles={styles} />
      </View>
    );
  }
  if (leaf === "list_schedules")
    return (
      <ScheduleList
        schedules={fieldArray(outputRecord, "schedules")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "schedule_logs")
    return (
      <ScheduleRuns
        runs={fieldArray(outputRecord, "runs")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "inspect_schedule" || leaf === "run_schedule_once")
    return (
      <View style={styles.paseoStack}>
        <ScheduleSummary
          schedule={outputRecord}
          palette={palette}
          styles={styles}
        />
        <ScheduleRuns
          runs={fieldArray(outputRecord, "runs")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  if (leaf === "create_schedule" || leaf === "create_heartbeat") {
    return (
      <View style={styles.paseoStack}>
        <PromptBlock
          text={notInHeader(fieldString(inputRecord, "prompt"), headerSummary)}
          styles={styles}
        />
        <Section title={t("ui.configuration")} styles={styles}>
          <PaseoFields
            fields={[
              [t("ui.name"), inputRecord?.name],
              [t("ui.cronExpression"), inputRecord?.cron],
              [t("ui.timeZone"), inputRecord?.timezone],
              [t("ui.provider"), inputRecord?.provider],
              [t("ui.workingDirectory"), inputRecord?.cwd],
              [t("ui.isolation"), inputRecord?.isolation],
              [t("ui.maximumRuns"), inputRecord?.maxRuns],
              [t("ui.expiresIn"), inputRecord?.expiresIn],
            ]}
            palette={palette}
            styles={styles}
          />
        </Section>
        <ScheduleSummary
          schedule={outputRecord}
          input={inputRecord}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  }
  if (leaf === "update_schedule")
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            [t("ui.schedule"), inputRecord?.id],
            [t("ui.name"), inputRecord?.name],
            [t("ui.prompt"), inputRecord?.prompt],
            [t("ui.cronExpression"), inputRecord?.cron],
            [t("ui.timeZone"), inputRecord?.timezone],
            [t("ui.provider"), inputRecord?.provider],
            [t("ui.model"), inputRecord?.model],
            [t("ui.mode"), inputRecord?.mode],
            [t("ui.workingDirectory"), inputRecord?.cwd],
            [t("ui.maximumRuns"), inputRecord?.maxRuns],
            [t("ui.expiresIn"), inputRecord?.expiresIn],
            [t("ui.clearExpiration"), inputRecord?.clearExpires],
          ]}
          palette={palette}
          styles={styles}
        />
        <ScheduleSummary
          schedule={outputRecord}
          input={inputRecord}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}

function ScheduleSummary({
  schedule,
  input = null,
  palette,
  styles,
}: {
  schedule: JsonRecord | null;
  /** Tool input already rendered above; result values that just echo it are skipped. */
  input?: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (!schedule) return null;
  const echoed = (key: string) =>
    input?.[key] !== undefined && input[key] === schedule[key];
  const cadence = asRecord(schedule.cadence);
  const target = asRecord(schedule.target);
  const targetConfig = asRecord(target?.config);
  return (
    <View style={styles.paseoStack}>
      <OutputFields
        result={schedule}
        fields={[
          ["id", t("ui.id")],
          ["name", t("ui.name")],
          ["status", t("ui.status")],
          ["nextRunAt", t("ui.nextRun2")],
          ["lastRunAt", t("ui.lastRun")],
          ["expiresAt", t("ui.expiresAt")],
          ["maxRuns", t("ui.maximumRuns")],
        ].filter(([key]) => !echoed(key)) as Array<[string, string]>}
        palette={palette}
        styles={styles}
      />
      <PromptBlock
        text={echoed("prompt") ? undefined : fieldString(schedule, "prompt")}
        styles={styles}
      />
      <Section title={t("ui.cadenceAndTarget")} styles={styles}>
        <PaseoFields
          fields={[
            [t("ui.cadence"), cadence],
            [t("ui.target"), target?.type],
            [t("ui.agent"), target?.agentId],
            [t("ui.provider"), targetConfig?.provider],
            [t("ui.model"), targetConfig?.model],
            [t("ui.mode"), targetConfig?.modeId],
            [t("ui.workingDirectory"), targetConfig?.cwd],
            [t("ui.isolation"), targetConfig?.isolation],
          ]}
          palette={palette}
          styles={styles}
        />
      </Section>
    </View>
  );
}

function ScheduleList({
  schedules,
  palette,
  styles,
}: {
  schedules: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (schedules.length === 0) {
    return <Text style={styles.empty}>{t("ui.noSchedulesReturned")}</Text>;
  }
  return (
    <Section title={t("ui.schedules", { count: schedules.length })} styles={styles}>
      <View style={styles.paseoList}>
        {schedules.map((schedule) => {
          const record = asRecord(schedule);
          const expression = fieldString(asRecord(record?.cadence), "expression");
          const nextRunAt = fieldString(record, "nextRunAt");
          return (
            <View
              key={stableItemKey(schedule, "schedule")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    t("ui.schedule")}
                </Text>
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              {/* 本地补丁（0.6.0，opus-F53）：cron 表达式后面接设备时区的下次运行时间（暂停、结束的没有下次）。 */}
              {nextRunAt ? (
                <InstantText
                  value={nextRunAt}
                  prefix={t("ui.nextRun", { prefix: expression ? `${expression} · ` : "" })}
                  style={styles.paseoListItemMeta}
                  palette={palette}
                  styles={styles}
                />
              ) : expression ? (
                <Text style={styles.paseoListItemMeta}>{expression}</Text>
              ) : null}
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "prompt")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ScheduleRuns({
  runs,
  palette,
  styles,
}: {
  runs: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (runs.length === 0) {
    return <Text style={styles.empty}>{t("ui.noRunHistory")}</Text>;
  }
  return (
    <Section title={t("ui.runHistory", { count: runs.length })} styles={styles}>
      <View style={styles.paseoList}>
        {runs.map((run) => {
          const record = asRecord(run);
          const scheduledFor = fieldString(record, "scheduledFor");
          return (
            <View key={stableItemKey(run, "run")} style={styles.paseoListItem}>
              <View style={styles.paseoListItemHeader}>
                {/* 本地补丁（0.6.0，opus-F53）：这次运行排定的时刻，按设备时区显示。 */}
                {scheduledFor ? (
                  <InstantText
                    value={scheduledFor}
                    style={styles.paseoListItemTitle}
                    containerStyle={ROW_FILL}
                    palette={palette}
                    styles={styles}
                  />
                ) : (
                  <Text style={styles.paseoListItemTitle}>
                    {fieldString(record, "id") ?? t("ui.run")}
                  </Text>
                )}
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {[
                  fieldString(record, "agentId"),
                  fieldString(record, "workspaceId"),
                ]
                  .filter(Boolean)
                  .join(t("ui.metaSeparator"))}
              </Text>
              {fieldString(record, "output") ? (
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "output")}
                </Text>
              ) : null}
              {fieldString(record, "error") ? (
                <Text
                  selectable
                  style={[
                    styles.paseoListItemMeta,
                    { color: palette.statusColors.failed },
                  ]}
                >
                  {fieldString(record, "error")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ProviderTool({
  leaf,
  headerSummary,
  input,
  result,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output" | "theme"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  if (leaf === "list_providers")
    return (
      <ProviderList
        providers={fieldArray(outputRecord, "providers")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "list_models")
    return (
      <View style={styles.paseoStack}>
        {notInHeader(fieldString(outputRecord, "provider"), headerSummary) ? (
          <PaseoFields
            fields={[[t("ui.provider"), outputRecord?.provider]]}
            palette={palette}
            styles={styles}
          />
        ) : null}
        <ModelList
          models={fieldArray(outputRecord, "models")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  if (leaf === "list_profiles")
    return (
      <ProfileList
        profiles={fieldArray(outputRecord, "profiles")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "inspect_provider")
    return (
      <View style={styles.paseoStack}>
        <MetaLine parts={[fieldString(outputRecord, "description")]} styles={styles} />
        <PaseoFields
          fields={[
            [t("ui.provider"), outputRecord?.provider ?? inputRecord?.provider],
            [t("ui.name"), outputRecord?.label],
            [t("ui.status"), outputRecord?.status, "status"],
            [t("ui.enabled"), outputRecord?.enabled],
            [t("ui.selectedModel"), outputRecord?.selectedModel],
          ]}
          palette={palette}
          styles={styles}
        />
        <ModeList
          modes={fieldArray(outputRecord, "modes")}
          palette={palette}
          styles={styles}
        />
        <FeatureList
          features={fieldArray(outputRecord, "features")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}

function ProviderList({
  providers,
  palette,
  styles,
}: {
  providers: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (providers.length === 0) {
    return <Text style={styles.empty}>{t("ui.noProvidersReturned")}</Text>;
  }
  return (
    <Section title={t("ui.providersCount", { count: providers.length })} styles={styles}>
      <View style={styles.paseoList}>
        {providers.map((provider) => {
          const record = asRecord(provider);
          return (
            <View
              key={stableItemKey(provider, "provider")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    t("ui.provider")}
                </Text>
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ModelList({
  models,
  palette,
  styles,
}: {
  models: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (models.length === 0) {
    return <Text style={styles.empty}>{t("ui.noModelsReturned")}</Text>;
  }
  return (
    <Section title={t("ui.models", { count: models.length })} styles={styles}>
      <View style={styles.paseoList}>
        {models.map((model) => {
          const record = asRecord(model);
          return (
            <View
              key={stableItemKey(model, "model")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    t("ui.model")}
                </Text>
                {fieldBoolean(record, "isDefault") ? (
                  <StatusPill
                    value="Default"
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
              {fieldString(record, "description") ? (
                <Text style={styles.paseoListItemMeta}>
                  {fieldString(record, "description")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ProfileList({
  profiles,
  palette,
  styles,
}: {
  profiles: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (profiles.length === 0) {
    return <Text style={styles.empty}>{t("ui.noConfigurationsReturned")}</Text>;
  }
  return (
    <Section title={t("ui.configurations", { count: profiles.length })} styles={styles}>
      <View style={styles.paseoList}>
        {profiles.map((profile) => {
          const record = asRecord(profile);
          return (
            <View
              key={stableItemKey(profile, "profile")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    t("ui.configuration")}
                </Text>
              </View>
              <PaseoFields
                fields={[
                  [t("ui.provider"), record?.provider],
                  [t("ui.model"), record?.model],
                  [t("ui.mode"), record?.modeId],
                  [t("ui.thinkingLevel"), record?.thinkingOptionId],
                ]}
                palette={palette}
                styles={styles}
              />
              {fieldString(record, "notes") ? (
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "notes")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function FeatureList({
  features,
  palette,
  styles,
}: {
  features: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (features.length === 0) return null;
  return (
    <Section title={t("ui.features", { count: features.length })} styles={styles}>
      <View style={styles.paseoList}>
        {features.map((feature) => {
          const record = asRecord(feature);
          return (
            <View
              key={stableItemKey(feature, "feature")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    t("ui.feature")}
                </Text>
                {record?.value !== undefined ? (
                  <StatusPill
                    value={scalarText(record.value)}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function BrowserTool({
  leaf,
  headerSummary,
  input,
  output,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName"> & { leaf: string;
  headerSummary: string | undefined; result: unknown }) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(output);
  const resultRecord = asRecord(result);
  const browserResult =
    resultRecord?.ok === true ? asRecord(resultRecord.result) : resultRecord;
  const browserFailure =
    outputRecord?.ok === false
      ? outputRecord
      : resultRecord?.ok === false
        ? resultRecord
        : null;
  if (browserFailure) {
    const error = asRecord(browserFailure.error);
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            [t("ui.browserTab"), unlessInHeader(inputRecord?.browserId, headerSummary)],
            [t("ui.error"), error?.message],
            [t("ui.retryable"), error?.retryable],
          ]}
          palette={palette}
          styles={styles}
        />
        <StatusPill value="Failed" palette={palette} styles={styles} />
      </View>
    );
  }
  switch (leaf) {
    case "browser_list_tabs":
      return (
        <BrowserTabList
          tabs={fieldArray(asRecord(browserResult), "tabs")}
          palette={palette}
          styles={styles}
        />
      );
    case "browser_new_tab":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.browserTab"), unlessInHeader(asRecord(browserResult)?.browserId, headerSummary)],
              [t("ui.workspace"), asRecord(browserResult)?.workspaceId],
              [t("ui.uRL"), unlessInHeader(asRecord(browserResult)?.url, headerSummary)],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "browser_snapshot":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.browserTab"), unlessInHeader(browserResult?.browserId, headerSummary)],
              [t("ui.uRL"), unlessInHeader(browserResult?.url, headerSummary)],
              [t("ui.title"), browserResult?.title],
              [t("ui.format"), browserResult?.format],
              [t("ui.truncated"), browserResult?.truncated],
              [t("ui.statistics"), browserResult?.stats],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(browserResult, "snapshot") ? (
            <PaseoCodeBlock
              code={fieldString(browserResult, "snapshot")!}
              language="yaml"
              label={t("ui.pageStructure")}
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    case "browser_screenshot":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.browserTab"), unlessInHeader(browserResult?.browserId, headerSummary)],
              [t("ui.mIMEType"), browserResult?.mimeType],
              [t("ui.width"), browserResult?.width],
              [t("ui.height"), browserResult?.height],
              [t("ui.fullPage"), inputRecord?.fullPage],
            ]}
            palette={palette}
            styles={styles}
          />
          <Text style={styles.mutedText}>
            {t("ui.theScreenshotWasReturnedTo")}</Text>
        </View>
      );
    case "browser_logs":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.browserTab"), unlessInHeader(browserResult?.browserId, headerSummary)],
              [t("ui.maximumEntries"), inputRecord?.maxEntries],
            ]}
            palette={palette}
            styles={styles}
          />
          <BrowserLogs
            consoleEntries={fieldArray(browserResult, "console")}
            networkEntries={fieldArray(browserResult, "network")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "browser_evaluate":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              [t("ui.browserTab"), unlessInHeader(browserResult?.browserId, headerSummary)],
              [t("ui.element"), inputRecord?.ref],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(inputRecord, "function") ? (
            <PaseoCodeBlock
              code={fieldString(inputRecord, "function")!}
              language="javascript"
              label={t("ui.function")}
              theme={theme}
              styles={styles}
            />
          ) : null}
          {fieldString(browserResult, "resultJson") ? (
            <PaseoCodeBlock
              code={fieldString(browserResult, "resultJson")!}
              language="json"
              label={t("ui.result")}
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    default: {
      const visible = (fields: Array<[string, unknown, string?]>) =>
        fields
          .map(([label, value]) => [label, unlessInHeader(value, headerSummary)] as [string, unknown])
          .filter(([, value]) => value !== undefined);
      const inputFields = visible(browserInputFields(leaf, inputRecord));
      const outputFields = visible(browserOutputFields(leaf, browserResult));
      return (
        <View style={styles.paseoStack}>
          <PaseoFields fields={inputFields} palette={palette} styles={styles} />
          <PaseoFields fields={outputFields} palette={palette} styles={styles} />
        </View>
      );
    }
  }
}

function browserInputFields(
  leaf: string,
  input: JsonRecord | null
): Array<[string, unknown, string?]> {
  if (!input) return [];
  const labels: Record<string, string> = {
    browserId: t("ui.browserTab"),
    ref: t("ui.element"),
    sourceRef: t("ui.sourceElement"),
    targetRef: t("ui.targetElement"),
    url: t("ui.uRL"),
    value: t("ui.value"),
    text: t("ui.text2"),
    key: t("ui.keys"),
    button: t("ui.mouseButton"),
    doubleClick: t("ui.doubleClick"),
    modifiers: t("ui.modifiers"),
    filePaths: t("ui.file"),
    fullPage: t("ui.fullPage"),
    maxEntries: t("ui.maximumEntries"),
    timeoutMs: t("ui.timeoutMilliseconds"),
    deltaX: t("ui.horizontalScroll"),
    deltaY: t("ui.verticalScroll"),
    width: t("ui.width"),
    height: t("ui.height"),
    function: t("ui.function"),
  };
  const excluded = new Set(["browserId"]);
  return Object.entries(input)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        (!excluded.has(key) || leaf === "browser_list_tabs")
    )
    .map(([key, value]) => [labels[key] ?? humanizeKey(key), value, key]);
}

function browserOutputFields(
  leaf: string,
  result: JsonRecord | null
): Array<[string, unknown, string?]> {
  if (!result) return [];
  const excluded = new Set([
    "command",
    "browserId",
    "snapshot",
    "console",
    "network",
    "resultJson",
  ]);
  return Object.entries(result)
    .filter(([key, value]) => value !== undefined && !excluded.has(key))
    .map(([key, value]) => [humanizeKey(key), value, key]);
}

function BrowserTabList({
  tabs,
  palette,
  styles,
}: {
  tabs: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (tabs.length === 0) {
    return <Text style={styles.empty}>{t("ui.noBrowserTabsReturned")}</Text>;
  }
  return (
    <Section title={t("ui.browserTabs", { count: tabs.length })} styles={styles}>
      <View style={styles.paseoList}>
        {tabs.map((tab) => {
          const record = asRecord(tab);
          return (
            <View key={stableItemKey(tab, "tab")} style={styles.paseoListItem}>
              <View style={styles.paseoListItemHeader}>
                <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                  {fieldString(record, "title") ?? t("ui.untitledPage")}
                </Text>
                {fieldBoolean(record, "isActive") ? (
                  <StatusPill
                    value="Active"
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "url")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "browserId")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function BrowserLogs({
  consoleEntries,
  networkEntries,
  palette,
  styles,
}: {
  consoleEntries: unknown[];
  networkEntries: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.paseoStack}>
      <Section title={t("ui.console", { count: consoleEntries.length })} styles={styles}>
        <View style={styles.paseoList}>
          {consoleEntries.map((entry) => {
            const record = asRecord(entry);
            const level = fieldString(record, "level") ?? "log";
            return (
              <View
                key={stableItemKey(entry, "console")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text style={[styles.paseoListItemTitle, { color: statusColor(level, palette) }]}>{level}</Text>
                  <Text style={[styles.paseoListItemMeta, ROW_TAIL]}>
                    {fieldString(record, "source")}
                  </Text>
                </View>
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "message")}
                </Text>
              </View>
            );
          })}
        </View>
      </Section>
      <Section title={t("ui.networkRequests", { count: networkEntries.length })} styles={styles}>
        <View style={styles.paseoList}>
          {networkEntries.map((entry) => {
            const record = asRecord(entry);
            return (
              <View
                key={stableItemKey(entry, "network")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {fieldString(record, "method") ?? t("ui.request")}{" "}
                    {fieldNumber(record, "status") ?? ""}
                  </Text>
                  <Text style={styles.paseoListItemMeta}>
                    {t("ui.milliseconds", { count: fieldNumber(record, "duration") })}
                  </Text>
                </View>
                <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                  {fieldString(record, "url")}
                </Text>
              </View>
            );
          })}
        </View>
      </Section>
    </View>
  );
}

function ExaResultList({
  results,
  styles,
}: {
  results: ExaSearchResult[];
  styles: ActivityStyles;
}) {
  return (
    <Section title={t("ui.results", { count: results.length })} styles={styles}>
      <View style={styles.paseoList}>
        {results.map((result) => (
          <View key={result.url ?? result.title} style={styles.paseoListItem}>
            {/* 本地补丁（0.6.0，opus-F49）：标题样式带 flex: 1，放在 row 里才安全；直接放进自动高度的列，原生端可能塌成 0 高。 */}
            <View style={styles.paseoListItemHeader}>
              <Text selectable style={styles.paseoListItemTitle}>
                {result.title}
              </Text>
            </View>
            {result.url ? (
              <Text selectable style={styles.paseoListItemMeta}>
                {result.url}
              </Text>
            ) : null}
            {result.published || result.author ? (
              <Text style={styles.paseoListItemMeta}>
                {[result.published, result.author].filter(Boolean).join(t("ui.metaSeparator"))}
              </Text>
            ) : null}
            {result.highlights ? (
              <Text selectable style={styles.paseoListItemMeta}>
                {result.highlights}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </Section>
  );
}

export function ExaToolDetail({
  toolName,
  input,
  output,
  theme,
  styles,
}: {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  styles: ActivityStyles;
}) {
  const kind = exaToolKind(toolName);
  if (!kind) return null;
  const results = kind === "search" ? parseExaSearchResults(output) : [];
  const outputText = exaOutputText(output);
  const inputRecord = asRecord(input);
  const query = fieldString(inputRecord, "query");
  const url = fieldString(inputRecord, "url");
  const prompt = fieldString(inputRecord, "prompt");
  const headerSummary = exaToolSummary(kind, input);
  const shownQuery = notInHeader(query, headerSummary);
  const shownUrl = notInHeader(url, headerSummary);
  const shownPrompt = notInHeader(prompt, headerSummary);
  return (
    <View style={styles.paseoStack}>
      {shownQuery ? <PromptBlock text={shownQuery} label={t("ui.query2")} styles={styles} /> : null}
      {shownUrl ? <PromptBlock text={shownUrl} label={t("ui.uRL")} styles={styles} /> : null}
      {shownPrompt ? <PromptBlock text={shownPrompt} label={t("ui.prompt")} styles={styles} /> : null}
      {results.length > 0 ? (
        <ExaResultList results={results} styles={styles} />
      ) : outputText ? (
        <PaseoCodeBlock
          code={outputText}
          language="markdown"
          label={t("ui.output")}
          theme={theme}
          styles={styles}
        />
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

function FallbackPaseo({
  input,
  result,
  palette,
  styles,
}: {
  input: unknown;
  result: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.paseoStack}>
      <Section title={t("ui.input")} styles={styles}>
        <PaseoFieldValue value={input} palette={palette} styles={styles} />
      </Section>
      <Section title={t("ui.result")} styles={styles}>
        <PaseoFieldValue value={result} palette={palette} styles={styles} />
      </Section>
    </View>
  );
}

function PaseoFailure({
  result,
  palette,
  styles,
}: {
  result: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const failure = asRecord(result);
  const error = asRecord(failure?.error);
  return (
    <View style={styles.paseoStack}>
      <StatusPill value="Failed" palette={palette} styles={styles} />
      <PaseoFields
        fields={[
          [t("ui.errorCode"), error?.code],
          [t("ui.error"), error?.message ?? failure?.error],
          [t("ui.retryable"), error?.retryable],
        ]}
        palette={palette}
        styles={styles}
      />
    </View>
  );
}

// 本地补丁：常见字段名（Agent 能力、通用结果字段）的中文名；没列出的字段名属于数据，按原样人性化。
const FIELD_ZH: Readonly<Record<string, string>> = {
  get supportsStreaming() { return t("ui.streamingOutput"); }, get supportsSessionPersistence() { return t("ui.sessionPersistence"); }, get supportsSessionListing() { return t("ui.listSessions"); },
  get supportsDynamicModes() { return t("ui.dynamicModes"); }, get supportsMcpServers() { return t("ui.mCPServers"); }, get supportsReasoningStream() { return t("ui.thinkingStream"); },
  get supportsToolInvocations() { return t("ui.toolCalls2"); }, get supportsRewindConversation() { return t("ui.rewindConversation"); }, get supportsRewindFiles() { return t("ui.rewindFiles"); },
  get supportsRewindBoth() { return t("ui.rewindConversationAndFiles"); },
  get id() { return t("ui.id"); }, get agentId() { return t("ui.agentId"); }, get workspaceId() { return t("ui.workspaceID"); }, get projectId() { return t("ui.projectID"); }, get terminalId() { return t("ui.terminalID"); }, get browserId() { return t("ui.browserTab"); },
  get title() { return t("ui.title"); }, get name() { return t("ui.name"); }, get status() { return t("ui.status"); }, get cwd() { return t("ui.workingDirectory"); }, get provider() { return t("ui.provider"); }, get model() { return t("ui.model"); }, get mode() { return t("ui.mode"); },
  get modeId() { return t("ui.mode"); }, get prompt() { return t("ui.prompt"); }, get message() { return t("ui.message"); }, get error() { return t("ui.error"); }, get output() { return t("ui.output"); }, get result() { return t("ui.result"); }, get url() { return t("ui.uRL"); },
  get path() { return t("ui.path2"); }, get branch() { return t("ui.branch2"); }, get createdAt() { return t("ui.createdAt"); }, get updatedAt() { return t("ui.updatedAt"); }, get startedAt() { return t("ui.startedAt"); }, get finishedAt() { return t("ui.finishedAt"); },
  get ok() { return t("ui.success"); }, get success() { return t("ui.success"); }, get count() { return t("ui.count"); }, get total() { return t("ui.total"); }, get description() { return t("ui.description"); }, get labels() { return t("ui.labels"); }, get text() { return t("ui.text2"); },
};

function humanizeKey(key: string): string {
  if (FIELD_ZH[key]) return FIELD_ZH[key]!;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const sentence = words.join(" ").toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

export function PaseoToolDetail({
  toolName,
  input,
  output,
  theme,
  palette,
  styles,
}: PaseoProps) {
  const leaf = paseoToolLeafName(toolName);
  if (!leaf) return null;
  const result = paseoToolResult(output);
  const headerSummary = paseoToolSummary(toolName, input);
  if (asRecord(result)?.ok === false) {
    return <PaseoFailure result={result} palette={palette} styles={styles} />;
  }
  if (leaf.startsWith("browser_")) {
    return (
      <BrowserTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        output={output}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("agent") || leaf.includes("permission")) {
    return (
      <AgentTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("workspace") && !leaf.includes("script")) {
    return (
      <WorkspaceTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("terminal") || leaf.includes("workspace_script")) {
    return (
      <TerminalTool
        leaf={leaf}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("schedule") || leaf.includes("heartbeat")) {
    return (
      <ScheduleTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("provider") || leaf.includes("profile") || leaf === "list_models") {
    return (
      <ProviderTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf === "speak") {
    const inputRecord = asRecord(input);
    return (
      <View style={styles.paseoStack}>
        <PromptBlock
          text={notInHeader(fieldString(inputRecord, "text"), headerSummary)}
          label={t("ui.message")}
          styles={styles}
        />
        <ActionResult
          result={asRecord(result)}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  }
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}

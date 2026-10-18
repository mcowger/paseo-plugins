import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import {
  activitySettings,
  DEFAULT_ACTIVITY_SETTINGS,
  type ActivitySettings,
} from "../../shared/settings";
import { ActionButton, useDashboardStyles } from "./controls";
import { Page, PAGES, type PageId } from "./pages";
import { DashboardPreview } from "./preview";

const CONTENT_MAX = 520;

/**
 * Colorful Activity's settings dashboard.
 *
 * Three panes when the window allows it (navigation, controls, live preview),
 * two when it does not, and a tab strip plus a stacked preview on compact
 * layouts. Changes preview immediately and persist through the host settings
 * store, serialized so a burst of taps cannot race its own revisions.
 */
export function Dashboard({ theme, layout, host }: PluginScreenProps) {
  const styles = useDashboardStyles(theme);
  const settings = useSettings(activitySettings);
  const [draft, setDraft] = useState<ActivitySettings | null>(null);
  const [page, setPage] = useState<PageId>("activity");
  const saved = settings.status === "ready" ? settings.values : DEFAULT_ACTIVITY_SETTINGS;
  const values = draft ?? saved;
  const { width } = useWindowDimensions();
  const threePane = !layout.compact && width >= 1120;
  const twoPane = !layout.compact && width >= 760;

  // One save at a time, always against the revision the host last handed this
  // component. The loop this replaced sent its second write with a stale
  // revision, which the host refused, silently dropping the second tap.
  const revision = useRef<string | null>(null);
  if (settings.status === "ready") revision.current = settings.revision;
  const pending = useRef<ActivitySettings | null>(null);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const canSave = settings.status === "ready";
  const save = canSave ? settings.save : null;

  const flush = useCallback(async () => {
    if (!save || saving.current || !pending.current) return;
    const next = pending.current;
    pending.current = null;
    saving.current = true;
    setBusy(true);
    const ok = await save(next, revision.current ?? "");
    saving.current = false;
    setBusy(false);
    // On success the draft stays until the saved values arrive, so controls and
    // preview never flash back to the old setting. A failed write keeps the host's
    // values and leaves `saveError` visible; the host pushes its own change too.
    if (!ok) setDraft(null);
  }, [save]);

  const change = useCallback(
    (patch: Partial<ActivitySettings>) => {
      // Before the first read there is nothing safe to write against.
      if (!canSave) return;
      const next = { ...(pending.current ?? draft ?? saved), ...patch };
      pending.current = next;
      setDraft(next);
      void flush();
    },
    [canSave, draft, flush, saved],
  );

  const reset = useCallback(() => {
    pending.current = null;
    setDraft(null);
    // Also the recovery path when stored settings are invalid, where saving is refused.
    if (settings.status !== "loading") void settings.reset();
  }, [settings]);

  // The host's revision lands a tick after a save resolves: that is when the next
  // queued change may be written, and when a draft the host now matches can go.
  const state = canSave ? settings.revision : settings.status;
  useEffect(() => {
    if (pending.current) {
      void flush();
      return;
    }
    if (saving.current) return;
    setDraft((current) => (current && sameSettings(current, saved) ? null : current));
  }, [state, flush, saved]);

  const saveState = useMemo(() => {
    if (settings.status === "error" || settings.status === "invalid") return settings.error;
    if (settings.saveError) return settings.saveError;
    return draft ? "Saving…" : "Saved automatically";
  }, [draft, settings]);

  return (
    <View style={[styles.page, { flexDirection: "row" }]}>
      {twoPane ? <NavRail page={page} setPage={setPage} theme={theme} hostLabel={host.label} /> : null}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 20, paddingTop: 18 }}
        style={styles.page}
      >
        <View style={{ gap: 18 }}>
          <View style={{ alignItems: "flex-end", flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <View style={{ flex: 1, gap: 2, minWidth: 220 }}>
              <Text style={styles.title}>Colorful Activity</Text>
              <Text style={styles.subtitle}>
                Dense activity rows, code surfaces, and commands for Paseo's timeline.
              </Text>
            </View>
            <View style={{ alignItems: "center", flexDirection: "row", gap: 10 }}>
              <View style={{ alignItems: "center", flexDirection: "row", gap: 5 }}>
                <Icon
                  name={draft ? "Loader" : "Check"}
                  size={12}
                  color={draft ? styles.colors.foregroundMuted : styles.colors.statusSuccess}
                />
                <Text style={styles.small}>{saveState}</Text>
              </View>
              <ActionButton
                label="Defaults"
                icon="RotateCcw"
                onPress={reset}
                styles={styles}
                disabled={busy}
              />
            </View>
          </View>

          {twoPane ? null : <TabStrip page={page} setPage={setPage} theme={theme} />}

          <View
            style={
              threePane
                ? { alignItems: "flex-start", flexDirection: "row", gap: 20 }
                : { gap: 26 }
            }
          >
            <View
              style={[styles.page, threePane ? { maxWidth: CONTENT_MAX } : null]}
              pointerEvents={canSave ? "auto" : "none"}
            >
              {canSave ? null : (
                <Text style={styles.hint}>
                  {settings.status === "loading"
                    ? "Loading settings…"
                    : "Stored settings need to be reset before they can be changed."}
                </Text>
              )}
              <View style={!canSave ? { opacity: 0.5 } : null}>
                <Page page={page} prefs={values} change={change} theme={theme} layout={layout} />
              </View>
              {settings.status === "error" || settings.status === "invalid" ? (
                <Text style={[styles.hint, { color: styles.colors.statusDanger }]}>
                  {settings.error}
                </Text>
              ) : null}
            </View>
            <View style={threePane ? { flex: 1, minWidth: 360 } : undefined}>
              <DashboardPreview
                theme={theme}
                layout={layout}
                host={host}
                prefs={values}
                expansion={page === "rows" ? undefined : PREVIEW_EXPANSION}
              />
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** Whether a draft already holds the values the host has stored. */
function sameSettings(left: ActivitySettings, right: ActivitySettings): boolean {
  return (
    left.palette === right.palette &&
    left.quiet === right.quiet &&
    left.commandColor === right.commandColor &&
    left.codeChrome === right.codeChrome &&
    left.diffWrap === right.diffWrap &&
    left.replyCode === right.replyCode &&
    EXPANSION_KEYS.every((key) => left.expansion[key] === right.expansion[key])
  );
}

const EXPANSION_KEYS = [
  "thinking",
  "read",
  "edit",
  "write",
  "shell",
  "search",
  "fetch",
  "worktree_setup",
  "sub_agent",
  "plain_text",
  "plan",
  "ask",
  "speak",
  "todo",
  "unknown",
] as const;

/** Preview rows start open on pages whose controls are not about expansion. */
const PREVIEW_EXPANSION: ActivitySettings["expansion"] = {
  ...DEFAULT_ACTIVITY_SETTINGS.expansion,
  thinking: "always",
  edit: "always",
  shell: "always",
  read: "never",
  search: "never",
  todo: "always",
};

function NavRail({
  page,
  setPage,
  theme,
  hostLabel,
}: {
  page: PageId;
  setPage: (page: PageId) => void;
  theme: PluginTheme;
  hostLabel: string;
}) {
  const styles = useDashboardStyles(theme);
  const groups = useMemo(() => [...new Set(PAGES.map((entry) => entry.group))], []);
  return (
    <View style={styles.rail}>
      <View style={{ alignItems: "center", flexDirection: "row", gap: 9, paddingHorizontal: 8 }}>
        <View
          style={{
            alignItems: "center",
            backgroundColor: styles.colors.accent,
            borderRadius: 6,
            height: 26,
            justifyContent: "center",
            width: 26,
          }}
        >
          <Icon name="Palette" size={15} color={styles.colors.accentForeground} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowLabel, { fontWeight: "600" }]}>Colorful Activity</Text>
          <Text style={styles.small}>Paseo plugin</Text>
        </View>
      </View>
      {groups.map((group) => (
        <View key={group} style={{ gap: 2 }}>
          <Text style={[styles.label, { paddingHorizontal: 8 }]}>{group}</Text>
          {PAGES.filter((entry) => entry.group === group).map((entry) => {
            const active = entry.id === page;
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => setPage(entry.id)}
                style={[styles.railItem, active ? { backgroundColor: styles.colors.surface2 } : null]}
              >
                <Icon
                  name={entry.icon}
                  size={15}
                  color={active ? styles.colors.foreground : styles.colors.foregroundMuted}
                />
                <Text
                  style={[styles.railItemText, active ? { color: styles.colors.foreground } : null]}
                >
                  {entry.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
      <View style={{ flex: 1 }} />
      <View style={{ alignItems: "center", flexDirection: "row", gap: 7, paddingHorizontal: 8 }}>
        <View
          style={{ backgroundColor: styles.colors.statusSuccess, borderRadius: 3, height: 6, width: 6 }}
        />
        <Text numberOfLines={1} style={[styles.small, { flex: 1 }]}>
          Plugin active · {hostLabel}
        </Text>
      </View>
    </View>
  );
}

function TabStrip({
  page,
  setPage,
  theme,
}: {
  page: PageId;
  setPage: (page: PageId) => void;
  theme: PluginTheme;
}) {
  const styles = useDashboardStyles(theme);
  return (
    <ScrollView
      contentContainerStyle={{ gap: 6, paddingBottom: 2 }}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {PAGES.map((entry) => {
        const active = entry.id === page;
        return (
          <Pressable
            key={entry.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => setPage(entry.id)}
            style={[
              styles.railItem,
              { paddingVertical: 6 },
              active ? { backgroundColor: styles.colors.surface2 } : null,
            ]}
          >
            <Icon
              name={entry.icon}
              size={14}
              color={active ? styles.colors.foreground : styles.colors.foregroundMuted}
            />
            <Text style={[styles.railItemText, active ? { color: styles.colors.foreground } : null]}>
              {entry.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

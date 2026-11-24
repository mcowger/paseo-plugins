import type { ComponentType } from "react";
import { useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { approx, fmtDuration, fmtPercent, fmtRate, fmtTokPerSec, fmtTokens } from "./format";
import type { AgentSpeedStore } from "./store";
import { EMPTY_TEAM, type TeamView } from "./team";
import { preferences, type Preferences } from "../shared/preferences";

type Styles = ReturnType<typeof buildStyles>;

function buildStyles(theme: PluginHostProps["theme"], compact: boolean) {
  return {
    wrap: { gap: compact ? 6 : 8, padding: 2, minWidth: compact ? 220 : 280 },
    header: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      gap: 12,
    },
    title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    model: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
    row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
    label: { color: theme.colors.foregroundMuted, fontSize: 12 },
    value: { color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    hint: { color: theme.colors.statusWarning, fontSize: 11, marginTop: 2 },
    basis: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, gap: 8 },
    chips: { flexDirection: "row" as const, gap: 4 },
    chip: {
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    chipOn: {
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    chipText: { color: theme.colors.foregroundMuted, fontSize: 11 },
    chipTextOn: { color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" as const },
  };
}

function Row({ styles, label, value }: { styles: Styles; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

/**
 * Builds the popover body for one agent's pill. The returned component is a
 * stable identity so updating the pill never closes an open popover.
 */
export function makeSpeedDetails(
  store: AgentSpeedStore,
  getPrefs: () => Preferences,
  charsPerToken: () => number,
  onPrefsSaved: () => void,
  getTeamView: () => TeamView | null = () => null,
): ComponentType<PluginHostProps> {
  return function SpeedDetails({ theme, layout }: PluginHostProps) {
    useSyncExternalStore(store.subscribe, store.getSnapshot);
    const settings = useSettings(preferences);
    const styles = useMemo(() => buildStyles(theme, layout.compact), [theme, layout.compact]);
    const prefs = getPrefs();
    const now = Date.now();
    const state = store.state;
    const summary = store.summary(now);
    const team = getTeamView() ?? EMPTY_TEAM;
    // Children emit on their own stores; while any runs, a slow tick keeps
    // their numbers moving between the parent's own repaints.
    const [, tick] = useReducer((n: number) => n + 1, 0);
    const teamActive = team.running > 0;
    useEffect(() => {
      if (!teamActive) return undefined;
      const timer = setInterval(() => tick(), 500);
      return () => clearInterval(timer);
    }, [teamActive]);
    const cpt = charsPerToken();
    const running = state.phase === "running";
    const live = running ? store.liveTokPerSec(prefs.liveWindowSec, prefs.maxPlausibleTokPerSec) : null;
    const basis = settings.status === "ready" ? settings.values.numerator : null;
    const setBasis = (value: "live" | "decode" | "turn") => {
      if (settings.status !== "ready" || settings.values.numerator === value) return;
      void settings
        .save({ ...settings.values, numerator: value }, settings.revision)
        .then((ok) => {
          if (ok) onPrefsSaved();
        });
    };
    const prefillRate =
      summary.firstStepPromptTokens !== null && summary.prefillMs !== null && summary.prefillMs > 0
        ? summary.firstStepPromptTokens / (summary.prefillMs / 1000)
        : null;
    // With a warm prefix cache the model restores the prompt instead of
    // prefilling it: dividing new tokens by TTFT then measures cache load and
    // queueing, not prefill speed, so only the honest pieces are shown.
    const cacheDominant =
      summary.firstStepCachedTokens !== null &&
      (summary.firstStepPromptTokens ?? 0) <= summary.firstStepCachedTokens;
    const prefillValue =
      summary.prefillMs === null
        ? null
        : cacheDominant
          ? `${fmtTokens(summary.firstStepPromptTokens ?? 0, prefs.tokenFormat)} new + ${fmtTokens(
              summary.firstStepCachedTokens ?? 0,
              prefs.tokenFormat,
            )} cached \u00b7 ${fmtDuration(summary.prefillMs)}`
          : prefillRate !== null
            ? `${fmtRate(prefillRate)} tok/s \u00b7 ${fmtDuration(summary.prefillMs)}`
            : fmtDuration(summary.prefillMs);
    const noUsage = !state.sawUsage && state.phase !== "idle";

    const model = store.model ?? store.provider ?? "";
    return (
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.title}>
            {running ? (state.pausedAt !== null ? "\u23f8 " : "\u26a1 ") : ""}
            {fmtTokPerSec(summary.tokPerSecDecode, summary.approx)} decode
          </Text>
          {model ? (
            <Text style={styles.model} numberOfLines={1} ellipsizeMode="middle">
              {model}
            </Text>
          ) : null}
        </View>
        {basis !== null ? (
          <View style={styles.basis}>
            <Text style={styles.label}>pill shows</Text>
            <View style={styles.chips}>
              {(["live", "decode", "whole"] as const).map((label) => {
                const value = label === "whole" ? "turn" : label;
                const on = basis === value;
                return (
                  <Pressable
                    key={label}
                    onPress={() => setBasis(value)}
                    style={on ? styles.chipOn : styles.chip}
                  >
                    <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
        {running && live !== null ? (
          <Row styles={styles} label={`live (${prefs.liveWindowSec}s)`} value={fmtTokPerSec(live, summary.approx)} />
        ) : null}
        {summary.tokPerSecTurn !== null ? (
          <Row
            styles={styles}
            label="whole turn"
            value={fmtTokPerSec(summary.tokPerSecTurn, summary.approx)}
          />
        ) : null}
        {summary.prefillMs !== null ? (
          <Row styles={styles} label="prefill / TTFT" value={prefillValue ?? "\u2014"} />
        ) : null}
        <Row
          styles={styles}
          label="tokens"
          value={`in ${fmtTokens(summary.inputTokens, prefs.tokenFormat)} · out ${approx(
            fmtTokens(summary.estTokens, prefs.tokenFormat),
            summary.approx,
          )}`}
        />
        {summary.thinkingTokens >= 10 ? (
          <Row
            styles={styles}
            label={"thinking \u2248"}
            value={`${approx(fmtTokens(summary.thinkingTokens, prefs.tokenFormat), true)} tok (not in reported out)`}
          />
        ) : null}
        {summary.cacheHitRate !== null ? (
          <Row
            styles={styles}
            label="cache hit"
            value={`${fmtPercent(summary.cacheHitRate)} · cached ${fmtTokens(
              summary.cachedTokens,
              prefs.tokenFormat,
            )} / ${fmtTokens(summary.promptTokens, prefs.tokenFormat)}`}
          />
        ) : null}
        {state.ctxUsed !== null && state.ctxMax !== null ? (
          <Row
            styles={styles}
            label="context"
            value={`${fmtTokens(state.ctxUsed, prefs.tokenFormat)} / ${fmtTokens(state.ctxMax, prefs.tokenFormat)}`}
          />
        ) : null}
        <Row
          styles={styles}
          label="steps"
          value={`${summary.steps}${summary.waitMs > 0 ? ` \u00b7 gaps ${fmtDuration(summary.waitMs)}` : ""}`}
        />
        {summary.toolMs > 0 || summary.tooling ? (
          <Row
            styles={styles}
            label={summary.tooling ? "in a tool" : "tool time"}
            value={fmtDuration(summary.toolMs)}
          />
        ) : null}
        {summary.userWaitMs > 0 || summary.waiting ? (
          <Row
            styles={styles}
            label={summary.waiting ? "waiting for you" : "user wait"}
            value={fmtDuration(summary.userWaitMs)}
          />
        ) : null}
        {team.members.length > 0 || summary.delegated || summary.delegatedMs > 0 ? (
          <Row
            styles={styles}
            label={summary.delegated ? "subagents" : "delegated"}
            value={
              team.running > 0
                ? `${team.running} running \u00b7 ${fmtDuration(summary.delegatedMs)}`
                : fmtDuration(summary.delegatedMs)
            }
          />
        ) : null}
        {team.members.slice(0, 5).map((member) => (
          <Row
            key={member.id}
            styles={styles}
            label={member.title ?? member.id.slice(0, 8)}
            value={`${member.running ? fmtTokPerSec(member.liveTokPerSec, member.approx) : "\u2713"} \u00b7 ${approx(
              fmtTokens(member.estTokens, prefs.tokenFormat),
              member.approx,
            )} tok`}
          />
        ))}
        {team.running > 0 && (team.liveTokPerSec !== null || team.estTokens > 0) ? (
          <Row
            styles={styles}
            label="team"
            value={`${fmtTokPerSec(team.liveTokPerSec, team.approx)} \u00b7 ${approx(
              fmtTokens(team.estTokens, prefs.tokenFormat),
              team.approx,
            )} tok`}
          />
        ) : null}
        {summary.totalMs !== null ? (
          <Row styles={styles} label="turn time" value={fmtDuration(summary.totalMs)} />
        ) : null}
        {summary.partial && summary.observedMs !== null && summary.totalMs !== null ? (
          <Row
            styles={styles}
            label="observed"
            value={`${fmtDuration(summary.observedMs)} of ${fmtDuration(summary.totalMs)}`}
          />
        ) : null}
        <Row styles={styles} label="calibration" value={`${cpt.toFixed(1)} chars/tok`} />
        {summary.partial ? (
          <Text style={styles.hint}>
            Discovered while it was running: steps, tokens and cache cover the observed stretch
            only, so no whole-turn rate is claimed.
          </Text>
        ) : null}
        {noUsage ? (
          <Text style={styles.hint}>
            {store.everSawUsage
              ? "\u2248 estimated from characters: the current model call reports its usage when it finishes."
              : "\u2248 estimated from characters: no usage events from the provider. For exact tokens enable options.includeUsage: true for this model."}
          </Text>
        ) : null}
      </View>
    );
  };
}

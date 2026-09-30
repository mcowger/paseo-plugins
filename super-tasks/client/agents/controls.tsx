import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { TooltipPressable as Pressable } from "../ui/tooltip";

const TOUCH_HIT_SLOP = { top: 10, right: 10, bottom: 10, left: 10 } as const;

export type AgentLifecycleStatus = "initializing" | "idle" | "running" | "error" | "closed";
export type AgentAttentionReason = "finished" | "error" | "permission" | null;

interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

function parseHexColor(value: string): RgbColor | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("#")) return null;
  const digits = trimmed.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  let expanded = "";
  if (digits.length === 6 || digits.length === 8) {
    expanded = digits.slice(0, 6);
  } else if (digits.length === 3 || digits.length === 4) {
    for (const char of digits.slice(0, 3)) {
      expanded += `${char}${char}`;
    }
  } else {
    return null;
  }
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function linearSrgbChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  if (rgb === null) return 0;
  return (
    0.2126 * linearSrgbChannel(rgb.red) +
    0.7152 * linearSrgbChannel(rgb.green) +
    0.0722 * linearSrgbChannel(rgb.blue)
  );
}

export function isDarkTheme(theme: PluginTheme): boolean {
  return relativeLuminance(theme.colors.surface0) < 0.5;
}

export function statusDotColor(
  theme: PluginTheme,
  status: AgentLifecycleStatus,
  attentionReason: AgentAttentionReason,
): string {
  if (attentionReason === "permission") {
    return theme.colors.statusWarning;
  }
  if (attentionReason === "error" || status === "error") {
    return theme.colors.statusDanger;
  }
  if (status === "running" || status === "initializing") {
    return isDarkTheme(theme) ? "#5caaf6" : "#268ae0";
  }
  if (attentionReason === "finished") {
    return theme.colors.statusSuccess;
  }
  if (status === "idle" || status === "closed") {
    return theme.colors.foregroundMuted;
  }
  return theme.colors.foregroundMuted;
}

const OPACITY_FRAMES = [
  [1, 0, 0.78, 0, 0.56, 0.34],
  [0.78, 1, 0.56, 0, 0.34, 0],
  [0.56, 0.78, 0.34, 1, 0, 0],
  [0.34, 0.56, 0, 0.78, 0, 1],
  [0, 0.34, 0, 0.56, 1, 0.78],
  [0, 0, 1, 0.34, 0.78, 0.56],
] as const;

const DOT_IDS = [
  { id: "dot-0", index: 0 },
  { id: "dot-1", index: 1 },
  { id: "dot-2", index: 2 },
  { id: "dot-3", index: 3 },
  { id: "dot-4", index: 4 },
  { id: "dot-5", index: 5 },
] as const;

const OPACITY_STYLE_MAP: Record<number, ViewStyle> = {
  0: { opacity: 0 },
  0.34: { opacity: 0.34 },
  0.56: { opacity: 0.56 },
  0.78: { opacity: 0.78 },
  1: { opacity: 1 },
};

export interface AgentControlsStyles {
  readonly statusFrame: ViewStyle;
  readonly statusDot: ViewStyle;
  readonly statusRingTrack: ViewStyle;
  readonly statusRingArc: ViewStyle;
  readonly workingContainer: ViewStyle;
  readonly dotGrid: ViewStyle;
  readonly gridDot: ViewStyle;
  readonly zeroOpacity: ViewStyle;
  readonly workingLabel: TextStyle;
  readonly workingElapsed: TextStyle;
  readonly actionBar: ViewStyle;
  readonly ghostButton: ViewStyle;
  readonly ghostButtonPressed: ViewStyle;
  readonly stopButton: ViewStyle;
  readonly stopButtonPressed: ViewStyle;
  readonly stopIconInner: ViewStyle;
  readonly buttonDisabled: ViewStyle;
  readonly composerContainer: ViewStyle;
  readonly composerHelperText: TextStyle;
  readonly composerInput: TextStyle;
  readonly composerFooter: ViewStyle;
  readonly composerErrorSlot: ViewStyle;
  readonly composerErrorText: TextStyle;
  readonly sendButton: ViewStyle;
  readonly sendButtonPressed: ViewStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): AgentControlsStyles {
  const isDark = isDarkTheme(theme);
  const ghostPressedBg = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";

  return {
    statusFrame: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    statusRingTrack: {
      position: "absolute",
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 1.5,
      opacity: 0.3,
    },
    statusRingArc: {
      position: "absolute",
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 1.5,
      borderRightColor: "transparent",
      borderBottomColor: "transparent",
      borderLeftColor: "transparent",
      opacity: 0.9,
    },
    workingContainer: {
      flexDirection: "row",
      height: 24,
      gap: 12,
      alignItems: "center",
    },
    dotGrid: {
      width: 10,
      height: 16,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 2,
      alignItems: "center",
      justifyContent: "center",
    },
    gridDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.foreground,
    },
    zeroOpacity: {
      opacity: 0,
    },
    workingLabel: {
      fontSize: 12,
      color: theme.colors.foregroundMuted,
      fontWeight: "400",
    },
    workingElapsed: {
      fontSize: 12,
      color: theme.colors.foregroundMuted,
      fontWeight: "400",
      fontVariant: ["tabular-nums"],
    },
    actionBar: {
      flexDirection: "row",
      gap: 4,
      alignItems: "center",
    },
    ghostButton: {
      width: compact ? 32 : 26,
      height: compact ? 32 : 26,
      borderRadius: 6,
      backgroundColor: "transparent",
      alignItems: "center",
      justifyContent: "center",
    },
    ghostButtonPressed: {
      backgroundColor: ghostPressedBg,
    },
    stopButton: {
      width: compact ? 28 : 26,
      height: compact ? 28 : 26,
      borderRadius: compact ? 14 : 13,
      backgroundColor: "#dc2626",
      alignItems: "center",
      justifyContent: "center",
    },
    stopButtonPressed: {
      opacity: 0.85,
    },
    stopIconInner: {
      width: 10,
      height: 10,
      borderRadius: 2,
      backgroundColor: "#ffffff",
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    composerContainer: {
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 16,
      padding: compact ? 12 : 16,
      gap: 12,
    },
    composerHelperText: {
      fontSize: 11,
      color: theme.colors.foregroundMuted,
      fontWeight: "400",
    },
    composerInput: {
      fontSize: 15,
      lineHeight: 21,
      color: theme.colors.foreground,
      minHeight: 48,
      padding: 0,
      textAlignVertical: "top",
    },
    composerFooter: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
    },
    composerErrorSlot: {
      flex: 1,
      justifyContent: "center",
    },
    composerErrorText: {
      fontSize: 12,
      color: theme.colors.statusDanger,
    },
    sendButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    sendButtonPressed: {
      opacity: 0.85,
    },
  };
}

/** 6px dot; when status === "running" renders the animated rotating-arc ring. Total footprint 14x14 in all states. */
export function AgentStatusIndicator({
  theme,
  status,
  attentionReason,
}: {
  theme: PluginTheme;
  status: AgentLifecycleStatus;
  attentionReason: AgentAttentionReason;
}): ReactElement {
  const styles = useMemo(() => createStyles(theme, false), [theme]);
  const isRunning = status === "running";
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isRunning) {
      rotateAnim.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    animation.start();
    return () => {
      animation.stop();
      rotateAnim.setValue(0);
    };
  }, [isRunning, rotateAnim]);

  const spinInterpolation = useMemo(
    () =>
      rotateAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ["0deg", "360deg"],
      }),
    [rotateAnim],
  );

  const dotColor = useMemo(
    () => statusDotColor(theme, status, attentionReason),
    [theme, status, attentionReason],
  );

  const nonRunningDotStyle = useMemo(
    () => ({
      backgroundColor: dotColor,
      opacity: status === "idle" && attentionReason === null ? 0.3 : 1,
    }),
    [dotColor, status, attentionReason],
  );

  const runningTrackStyle = useMemo(
    () => ({
      borderColor: dotColor,
    }),
    [dotColor],
  );

  const runningArcColorStyle = useMemo(
    () => ({
      borderTopColor: dotColor,
    }),
    [dotColor],
  );

  const animatedTransformStyle = useMemo(
    () => ({
      transform: [{ rotate: spinInterpolation }],
    }),
    [spinInterpolation],
  );

  if (!isRunning) {
    return (
      <View style={styles.statusFrame}>
        <View style={[styles.statusDot, nonRunningDotStyle]} />
      </View>
    );
  }

  return (
    <View style={styles.statusFrame}>
      <View style={[styles.statusRingTrack, runningTrackStyle]} />
      <Animated.View style={[styles.statusRingArc, runningArcColorStyle, animatedTransformStyle]} />
      <View style={[styles.statusDot, nonRunningDotStyle]} />
    </View>
  );
}

function formatElapsed(startedAt: string): string {
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) {
    return "";
  }
  const nowMs = Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Animated working indicator shown while an agent is running; `startedAt` ISO string drives the elapsed counter (omit to hide it). */
export function WorkingIndicator({
  theme,
  compact,
  startedAt = null,
  label = "Working",
}: {
  theme: PluginTheme;
  compact: boolean;
  startedAt?: string | null;
  label?: string;
}): ReactElement {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const [frameIndex, setFrameIndex] = useState<number>(0);
  const [elapsed, setElapsed] = useState<string>(() => (startedAt ? formatElapsed(startedAt) : ""));

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((current) => (current + 1) % 6);
    }, 158);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!startedAt) {
      setElapsed("");
      return;
    }
    setElapsed(formatElapsed(startedAt));
    const timer = setInterval(() => {
      setElapsed(formatElapsed(startedAt));
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const dotOpacities = useMemo(() => {
    const frame = OPACITY_FRAMES[frameIndex];
    return DOT_IDS.map((dot) => frame?.[dot.index] ?? 0);
  }, [frameIndex]);

  return (
    <View style={styles.workingContainer}>
      <View style={styles.dotGrid}>
        {DOT_IDS.map((dot) => {
          const opacityValue = dotOpacities[dot.index] ?? 0;
          return (
            <View
              key={dot.id}
              style={[styles.gridDot, OPACITY_STYLE_MAP[opacityValue] ?? styles.zeroOpacity]}
            />
          );
        })}
      </View>
      <Text style={styles.workingLabel}>{label}</Text>
      {elapsed ? <Text style={styles.workingElapsed}>{elapsed}</Text> : null}
    </View>
  );
}

/** Row of ghost icon buttons: Thread, Open tab, Steer, Archive, and Stop while running. */
export function AgentActionBar({
  theme,
  compact,
  agentTitle,
  status,
  threadOpen,
  steerOpen,
  stopping,
  archiving,
  archived,
  onToggleThread,
  onOpen,
  onToggleSteer,
  onArchive,
  onStop,
}: {
  theme: PluginTheme;
  compact: boolean;
  agentTitle: string;
  status: AgentLifecycleStatus;
  threadOpen: boolean;
  steerOpen: boolean;
  stopping: boolean;
  archiving: boolean;
  archived: boolean;
  onToggleThread: (event: GestureResponderEvent) => void;
  onOpen: (event: GestureResponderEvent) => void;
  onToggleSteer: (event: GestureResponderEvent) => void;
  onArchive: (event: GestureResponderEvent) => void;
  onStop: (event: GestureResponderEvent) => void;
}): ReactElement {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const isRunning = status === "running";
  const iconSize = compact ? 16 : 14;
  const nativeHitSlop = Platform.OS === "web" ? undefined : TOUCH_HIT_SLOP;

  const steerAccessibilityState = useMemo(() => ({ selected: steerOpen }), [steerOpen]);
  const threadAccessibilityState = useMemo(() => ({ expanded: threadOpen }), [threadOpen]);

  const stopAccessibilityState = useMemo(() => ({ disabled: stopping }), [stopping]);
  const archiveAccessibilityState = useMemo(() => ({ disabled: archiving }), [archiving]);

  const openButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.ghostButton,
      pressed && styles.ghostButtonPressed,
    ],
    [styles],
  );

  const steerButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.ghostButton,
      (pressed || steerOpen) && styles.ghostButtonPressed,
    ],
    [styles, steerOpen],
  );

  const threadButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.ghostButton,
      (pressed || threadOpen) && styles.ghostButtonPressed,
    ],
    [styles, threadOpen],
  );
  const archiveButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.ghostButton,
      archiving && styles.buttonDisabled,
      pressed && !archiving && styles.ghostButtonPressed,
    ],
    [archiving, styles],
  );

  const stopButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.stopButton,
      stopping && styles.buttonDisabled,
      pressed && !stopping && styles.stopButtonPressed,
    ],
    [styles, stopping],
  );

  return (
    <View style={styles.actionBar}>
      <Pressable
        tooltip={`${threadOpen ? "Hide" : "Show"} thread of ${agentTitle}`}
        accessibilityRole="button"
        accessibilityLabel={`${threadOpen ? "Hide" : "Show"} thread of ${agentTitle}`}
        accessibilityState={threadAccessibilityState}
        onPress={onToggleThread}
        style={threadButtonStyle}
        hitSlop={nativeHitSlop}
      >
        <Icon
          name="ScrollText"
          size={iconSize}
          color={threadOpen ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      </Pressable>

      <Pressable
        tooltip={`Open ${agentTitle} in a tab`}
        accessibilityRole="button"
        accessibilityLabel={`Open ${agentTitle} in a tab`}
        onPress={onOpen}
        style={openButtonStyle}
        hitSlop={nativeHitSlop}
      >
        <Icon name="ExternalLink" size={iconSize} color={theme.colors.foregroundMuted} />
      </Pressable>

      <Pressable
        tooltip={`${steerOpen ? "Close" : "Steer"} ${agentTitle}`}
        accessibilityRole="button"
        accessibilityLabel={`Steer ${agentTitle}`}
        accessibilityState={steerAccessibilityState}
        onPress={onToggleSteer}
        style={steerButtonStyle}
        hitSlop={nativeHitSlop}
      >
        <Icon
          name="MessageSquare"
          size={iconSize}
          color={steerOpen ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      </Pressable>
      {!archived ? (
        <Pressable
          tooltip={archiving ? `Archiving ${agentTitle}` : `Archive ${agentTitle}`}
          accessibilityRole="button"
          accessibilityLabel={`Archive ${agentTitle}`}
          accessibilityState={archiveAccessibilityState}
          disabled={archiving}
          onPress={onArchive}
          style={archiveButtonStyle}
          hitSlop={nativeHitSlop}
        >
          <Icon name="Archive" size={iconSize} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}

      {isRunning ? (
        <Pressable
          tooltip={stopping ? `Stopping ${agentTitle}` : `Stop ${agentTitle}`}
          accessibilityRole="button"
          accessibilityLabel={`Stop ${agentTitle}`}
          accessibilityState={stopAccessibilityState}
          disabled={stopping}
          onPress={onStop}
          style={stopButtonStyle}
          hitSlop={nativeHitSlop}
        >
          <View style={styles.stopIconInner} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Paseo-style composer. Submit via button or Enter (Shift+Enter newline on web). Clears on success; shows error text on rejection; disables while sending. */
export function SteerComposer({
  theme,
  compact,
  status,
  onSubmit,
  autoFocus = false,
}: {
  theme: PluginTheme;
  compact: boolean;
  status: AgentLifecycleStatus;
  onSubmit: (text: string) => Promise<void>;
  autoFocus?: boolean;
}): ReactElement {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const [text, setText] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const isNative = Platform.OS !== "web";

  const helperText =
    status === "running" ? "Message is delivered into the active turn" : "Starts a new turn";

  const placeholder = status === "running" ? "Steer the active turn..." : "Send a prompt...";

  const canSend = text.trim().length > 0 && !sending;

  const sendAccessibilityState = useMemo(
    () => ({ disabled: !canSend, busy: sending }),
    [canSend, sending],
  );

  const handleTextChange = useCallback((value: string) => {
    setText(value);
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setText("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [text, sending, onSubmit]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (isNative) {
        return;
      }
      const nativeEvent = event.nativeEvent as TextInputKeyPressEventData & {
        shiftKey?: boolean;
        preventDefault?: () => void;
      };
      if (nativeEvent.key === "Enter" && !nativeEvent.shiftKey) {
        if (
          typeof (event as unknown as { preventDefault?: () => void }).preventDefault === "function"
        ) {
          (event as unknown as { preventDefault: () => void }).preventDefault();
        }
        if (typeof nativeEvent.preventDefault === "function") {
          nativeEvent.preventDefault();
        }
        void handleSubmit();
      }
    },
    [handleSubmit, isNative],
  );

  const sendButtonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.sendButton,
      !canSend && styles.buttonDisabled,
      pressed && canSend && styles.sendButtonPressed,
    ],
    [styles, canSend],
  );

  const composer = (
    <View style={styles.composerContainer}>
      <Text style={styles.composerHelperText}>{helperText}</Text>
      <TextInput
        style={styles.composerInput}
        value={text}
        onChangeText={handleTextChange}
        onKeyPress={isNative ? undefined : handleKeyPress}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline={true}
        blurOnSubmit={false}
        autoFocus={autoFocus}
        editable={!sending}
      />
      <View style={styles.composerFooter}>
        <View style={styles.composerErrorSlot}>
          {error ? <Text style={styles.composerErrorText}>{error}</Text> : null}
        </View>
        <Pressable
          tooltip={sending ? "Sending steer message" : "Send steer message"}
          accessibilityRole="button"
          accessibilityLabel="Send steer message"
          accessibilityState={sendAccessibilityState}
          disabled={!canSend}
          onPress={handleSubmit}
          hitSlop={isNative ? TOUCH_HIT_SLOP : undefined}
          style={sendButtonStyle}
        >
          <Icon name="ArrowUp" size={14} color={theme.colors.accentForeground} />
        </Pressable>
      </View>
    </View>
  );

  if (!isNative) {
    return composer;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>
      {composer}
    </KeyboardAvoidingView>
  );
}

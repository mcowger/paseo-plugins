import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ActivitySettings } from "../../shared/settings";
import { CodeCard, ColorfulReasoning, ColorfulTodo, ColorfulToolCall } from "../activity";
import { useActivityPrefs, PrefsOverride } from "../prefs";
import { Segmented, useDashboardStyles } from "./controls";
import {
  SAMPLE_CODE,
  SAMPLE_EDIT,
  SAMPLE_REASONING,
  SAMPLE_REPLY,
  SAMPLE_REPLY_INLINE,
  SAMPLE_SHELL,
  SAMPLE_TODO,
} from "./samples";

type Viewport = "desktop" | "phone";

/**
 * The live preview: the plugin's real renderers over sample data, reading draft
 * settings from `PrefsOverride`, so a tile or a segmented control shows its
 * effect on this frame while the save is in flight.
 *
 * `expansion` replaces the saved row-expansion modes on pages whose controls
 * have nothing to do with expansion, where a collapsed sample row would hide the
 * very surfaces the page is about. The Rows page passes the live values instead.
 */
export function DashboardPreview({
  theme,
  layout,
  host,
  prefs,
  expansion,
}: {
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
  host: PluginHostProps["host"];
  prefs: ActivitySettings;
  expansion?: ActivitySettings["expansion"];
}) {
  const styles = useDashboardStyles(theme);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const effective = useMemo<ActivitySettings>(
    () => (expansion ? { ...prefs, expansion } : prefs),
    [prefs, expansion],
  );
  const props = { agentId: "preview", timestamp: new Date(0), theme, host, layout };
  const item = <Data,>(data: Data) => ({
    type: "plugin" as const,
    kind: "colorful-preview",
    version: 1,
    data,
  });

  return (
    <View style={{ gap: 10 }}>
      <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
        <Text style={styles.sectionTitle}>Preview</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Live</Text>
        </View>
        <View style={{ flex: 1 }} />
        <View style={{ width: 168 }}>
          <Segmented<Viewport>
            accessibilityLabel="Preview width"
            value={viewport}
            options={[
              { value: "desktop", label: "Desktop" },
              { value: "phone", label: "Phone" },
            ]}
            onChange={setViewport}
            styles={styles}
          />
        </View>
      </View>
      <View
        style={[
          styles.frame,
          viewport === "phone" ? { maxWidth: 390, width: "100%" } : { maxWidth: 720 },
        ]}
      >
        <PrefsOverride.Provider value={effective}>
          <View style={{ gap: 10 }}>
            <View style={styles.bubble}>
              <Text style={styles.bubbleText}>
                Fix the auth middleware, then run the auth tests.
              </Text>
            </View>
            <ColorfulReasoning {...props} item={item(SAMPLE_REASONING)} />
            <ColorfulToolCall {...props} preview item={item(SAMPLE_EDIT)} />
            <ColorfulToolCall {...props} preview item={item(SAMPLE_SHELL)} />
            {SAMPLE_TODO ? <ColorfulTodo {...props} item={item(SAMPLE_TODO)} /> : null}
            <ReplySample theme={theme} styles={styles} />
          </View>
        </PrefsOverride.Provider>
      </View>
    </View>
  );
}

/**
 * The reply below the activity: prose with an inline code span, then a code block.
 *
 * It follows the **Replies** page: with the restyle on it shows the plugin's chip
 * and code card, with it off it shows the plain rendering Paseo uses, so the
 * toggle has a visible effect here even though the real restyle only reaches
 * host-rendered replies on desktop and web.
 */
function ReplySample({
  theme,
  styles,
}: {
  theme: PluginTheme;
  styles: ReturnType<typeof useDashboardStyles>;
}): ReactNode {
  const restyled = useActivityPrefs().replyCode === "on";
  const sentences = SAMPLE_REPLY.split(SAMPLE_REPLY_INLINE);
  return (
    <View style={{ gap: 8, paddingTop: 2 }}>
      <Text style={styles.body}>
        {sentences[0]}
        <Text
          style={{
            ...(restyled
              ? {
                  backgroundColor: styles.colors.surface2,
                  borderRadius: 3,
                  paddingHorizontal: 3,
                }
              : null),
            color: styles.colors.foreground,
            fontFamily: styles.mono,
            fontSize: 12,
          }}
        >
          {SAMPLE_REPLY_INLINE}
        </Text>
        {sentences[1]}
      </Text>
      {restyled ? (
        <CodeCard code={SAMPLE_CODE} language="typescript" theme={theme} />
      ) : (
        <View
          style={{
            backgroundColor: styles.colors.surface0,
            borderColor: styles.colors.border,
            borderRadius: 8,
            borderWidth: StyleSheet.hairlineWidth,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <Text
            style={{
              color: styles.colors.foreground,
              fontFamily: styles.mono,
              fontSize: 11.5,
              lineHeight: 17,
            }}
          >
            {SAMPLE_CODE}
          </Text>
        </View>
      )}
      <Text style={styles.small}>
        {restyled
          ? "Restyle on: inline chips and a language header on code blocks."
          : "Restyle off: Paseo's own reply rendering."}
      </Text>
    </View>
  );
}

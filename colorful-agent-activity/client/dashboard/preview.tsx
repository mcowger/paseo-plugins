import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { ActivitySettings } from "../../shared/settings";
import { CodeCard, ColorfulReasoning, ColorfulTodo, ColorfulToolCall } from "../activity";
import { PrefsOverride } from "../prefs";
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

/** The reply below the activity: prose with an inline code chip, then a code card. */
function ReplySample({
  theme,
  styles,
}: {
  theme: PluginTheme;
  styles: ReturnType<typeof useDashboardStyles>;
}): ReactNode {
  const sentences = SAMPLE_REPLY.split(SAMPLE_REPLY_INLINE);
  return (
    <View style={{ gap: 8, paddingTop: 2 }}>
      <Text style={styles.body}>
        {sentences[0]}
        <Text
          style={{
            backgroundColor: styles.colors.surface2,
            borderRadius: 3,
            color: styles.colors.foreground,
            fontFamily: styles.mono,
            fontSize: 12,
          }}
        >
          {" "}
          {SAMPLE_REPLY_INLINE}{" "}
        </Text>
        {sentences[1]}
      </Text>
      <CodeCard code={SAMPLE_CODE} language="typescript" theme={theme} />
    </View>
  );
}

import type { FC } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ThemeAppearance, ThemeStudioTokens } from "../shared/theme-types.js";
import { getLuminance } from "../shared/parser.js";

export interface MiniPreviewProps {
  tokens: ThemeStudioTokens;
  appearance: ThemeAppearance;
  compact?: boolean;
}

export const MiniPreview: FC<MiniPreviewProps> = ({ tokens, appearance, compact = false }) => {
  const fgLuminance = getLuminance(tokens.foreground);
  const bgLuminance = getLuminance(tokens.background);
  const contrastRatio =
    (Math.max(fgLuminance, bgLuminance) + 0.05) / (Math.min(fgLuminance, bgLuminance) + 0.05);

  const accentFg = getLuminance(tokens.accent) > 0.4 ? tokens.background : tokens.foreground;

  return (
    <View style={[styles.container, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
      {/* Window Titlebar */}
      <View style={[styles.titlebar, { borderBottomColor: tokens.border, backgroundColor: tokens.raised }]}>
        <View style={styles.windowButtons}>
          <View style={[styles.windowDot, { backgroundColor: tokens.accent }]} />
          <View style={[styles.windowDot, { backgroundColor: tokens.ring }]} />
          <View style={[styles.windowDot, { backgroundColor: tokens.foreground }]} />
        </View>
        <Text style={[styles.titlebarText, { color: tokens.mutedForeground }]} numberOfLines={1}>
          paseo workspace — live preview
        </Text>
        <View style={[styles.hostBadge, { backgroundColor: tokens.control, borderColor: tokens.border }]}>
          <View style={[styles.hostDot, { backgroundColor: tokens.accent }]} />
          <Text style={[styles.hostBadgeText, { color: tokens.foreground }]}>local</Text>
        </View>
      </View>

      {/* Main Workspace Frame */}
      <View style={styles.body}>
        {/* Left Sidebar Mockup */}
        {!compact && (
          <View style={[styles.sidebar, { borderRightColor: tokens.border, backgroundColor: tokens.raised }]}>
            <View style={styles.sidebarHeader}>
              <Icon name="Layers" size={14} color={tokens.accent} />
              <Text style={[styles.sidebarHeaderText, { color: tokens.foreground }]} numberOfLines={1}>
                Paseo App
              </Text>
            </View>

            <View style={styles.agentList}>
              <View
                style={[
                  styles.agentItem,
                  {
                    backgroundColor: tokens.control,
                    borderLeftColor: tokens.accent,
                    borderLeftWidth: 3,
                  },
                ]}
              >
                <Icon name="Bot" size={12} color={tokens.accent} />
                <Text style={[styles.agentItemText, { color: tokens.foreground }]} numberOfLines={1}>
                  assistant
                </Text>
              </View>

              <View style={[styles.agentItem, { opacity: 0.7 }]}>
                <Icon name="Terminal" size={12} color={tokens.mutedForeground} />
                <Text style={[styles.agentItemText, { color: tokens.mutedForeground }]} numberOfLines={1}>
                  subagent-1
                </Text>
              </View>
            </View>

            <View style={[styles.sidebarFooter, { borderTopColor: tokens.border }]}>
              <Icon name="Settings" size={12} color={tokens.mutedForeground} />
              <Text style={[styles.sidebarFooterText, { color: tokens.mutedForeground }]}>Settings</Text>
            </View>
          </View>
        )}

        {/* Right Conversation Timeline */}
        <View style={styles.timeline}>
          {/* User Message Bubble */}
          <View style={[styles.userBubble, { backgroundColor: tokens.control, borderColor: tokens.border }]}>
            <Text style={[styles.bubbleAuthor, { color: tokens.accent }]}>User</Text>
            <Text style={[styles.bubbleText, { color: tokens.foreground }]}>
              Generate the tailwind palette theme and run the test suite.
            </Text>
          </View>

          {/* Assistant Message */}
          <View style={styles.assistantRow}>
            <View style={[styles.assistantAvatar, { backgroundColor: tokens.accent }]}>
              <Icon name="Sparkles" size={12} color={accentFg} />
            </View>
            <View style={styles.assistantContent}>
              <Text style={[styles.bubbleText, { color: tokens.foreground }]}>
                I've compiled the theme tokens and executed all tests cleanly.
              </Text>
            </View>
          </View>

          {/* Tool Call Card */}
          <View style={[styles.toolCard, { backgroundColor: tokens.raised, borderColor: tokens.border }]}>
            <View style={[styles.toolHeader, { borderBottomColor: tokens.border }]}>
              <View style={styles.toolTitleGroup}>
                <View style={[styles.toolBadge, { backgroundColor: tokens.control }]}>
                  <Text style={[styles.toolBadgeText, { color: tokens.accent }]}>bash</Text>
                </View>
                <Text style={[styles.toolCommand, { color: tokens.foreground }]} numberOfLines={1}>
                  npm test
                </Text>
              </View>
              <View style={[styles.successBadge, { backgroundColor: tokens.control }]}>
                <Icon name="Check" size={11} color={tokens.accent} />
                <Text style={[styles.successText, { color: tokens.foreground }]}>passed</Text>
              </View>
            </View>
            <View style={[styles.toolOutput, { backgroundColor: tokens.background }]}>
              <Text style={[styles.toolOutputText, { color: tokens.mutedForeground }]}>
                ✓ 48 tests passed in 8 test files (1.2s)
              </Text>
            </View>
          </View>

          {/* Composer Input Mockup */}
          <View style={[styles.composer, { backgroundColor: tokens.control, borderColor: tokens.ring }]}>
            <Text style={[styles.composerPlaceholder, { color: tokens.mutedForeground }]}>
              Reply to assistant...
            </Text>
            <View style={[styles.sendButton, { backgroundColor: tokens.accent }]}>
              <Icon name="ArrowUp" size={12} color={accentFg} />
            </View>
          </View>
        </View>
      </View>

      {/* Footer Token Summary */}
      <View style={[styles.footer, { borderTopColor: tokens.border, backgroundColor: tokens.raised }]}>
        <View style={styles.swatchRow}>
          <Text style={[styles.contrastLabel, { color: tokens.mutedForeground }]}>
            Contrast: {contrastRatio.toFixed(1)}:1 ({appearance})
          </Text>
        </View>
        <View style={styles.swatchGrid}>
          {([
            ["bg", tokens.background],
            ["fg", tokens.foreground],
            ["raised", tokens.raised],
            ["ctrl", tokens.control],
            ["border", tokens.border],
            ["ring", tokens.ring],
            ["accent", tokens.accent],
          ] as const).map(([label, hex]) => (
            <View key={label} style={styles.swatchPill}>
              <View style={[styles.swatchDot, { backgroundColor: hex, borderColor: tokens.border }]} />
              <Text style={[styles.swatchText, { color: tokens.mutedForeground }]}>{label}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
  },
  titlebar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  windowButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  windowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  titlebarText: {
    fontSize: 11,
    fontFamily: "monospace",
  },
  hostBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    gap: 4,
  },
  hostDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  hostBadgeText: {
    fontSize: 10,
    fontWeight: "500",
  },
  body: {
    flexDirection: "row",
    minHeight: 220,
  },
  sidebar: {
    width: 120,
    borderRightWidth: 1,
    padding: 8,
    justifyContent: "space-between",
  },
  sidebarHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  sidebarHeaderText: {
    fontSize: 11,
    fontWeight: "600",
  },
  agentList: {
    gap: 4,
    flex: 1,
  },
  agentItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
  },
  agentItemText: {
    fontSize: 10,
    fontWeight: "500",
  },
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 6,
    borderTopWidth: 1,
  },
  sidebarFooterText: {
    fontSize: 10,
  },
  timeline: {
    flex: 1,
    padding: 10,
    gap: 8,
    justifyContent: "space-between",
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  bubbleAuthor: {
    fontSize: 9,
    fontWeight: "600",
    marginBottom: 2,
  },
  bubbleText: {
    fontSize: 11,
    lineHeight: 15,
  },
  assistantRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
  },
  assistantAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  assistantContent: {
    flex: 1,
  },
  toolCard: {
    borderRadius: 6,
    borderWidth: 1,
    overflow: "hidden",
  },
  toolHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
  },
  toolTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  toolBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  toolBadgeText: {
    fontSize: 9,
    fontWeight: "700",
    fontFamily: "monospace",
  },
  toolCommand: {
    fontSize: 10,
    fontFamily: "monospace",
  },
  successBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  successText: {
    fontSize: 9,
    fontWeight: "500",
  },
  toolOutput: {
    padding: 6,
  },
  toolOutputText: {
    fontSize: 9,
    fontFamily: "monospace",
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    marginTop: 4,
  },
  composerPlaceholder: {
    fontSize: 11,
  },
  sendButton: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopWidth: 1,
  },
  swatchRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  contrastLabel: {
    fontSize: 10,
    fontWeight: "500",
  },
  swatchGrid: {
    flexDirection: "row",
    gap: 6,
  },
  swatchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  swatchDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 0.5,
  },
  swatchText: {
    fontSize: 9,
    fontFamily: "monospace",
  },
});

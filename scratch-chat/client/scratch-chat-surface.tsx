import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { addDiscardComposerPill } from "./composer-pill.js";
import { createScratchChatRpc } from "../shared/create-scratch-chat.js";
import { discardScratchChatRpc } from "../shared/discard-scratch-chat.js";

export function ScratchChatSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const createChat = useRpc(createScratchChatRpc);
  const discardChat = useRpc(discardScratchChatRpc);
  const pill = useRef<ReturnType<typeof addDiscardComposerPill>>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const inFlight = useRef(false);
  const [status, setStatus] = useState<"loading" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const openChat = useCallback(() => {
    if (!navigation || !mounted.current || inFlight.current) {
      if (mounted.current) {
        setStatus("error");
        setError("Native navigation is unavailable");
      }
      return;
    }
    const requestId = ++request.current;
    inFlight.current = true;
    setStatus("loading");
    setError(null);
    void createChat({})
      .then(async ({ workspaceId, agentId }) => {
        if (!mounted.current || request.current !== requestId) {
          await discardChat({ agentId });
          return;
        }
        inFlight.current = false;
        try {
          pill.current?.remove();
          pill.current = addDiscardComposerPill(workspaceId, agentId, async () => {
            await discardChat({ agentId });
            pill.current?.remove();
            pill.current = null;
          });
          navigation.openAgent({ agentId });
        } catch (error) {
          await discardChat({ agentId }).catch(() => undefined);
          throw error;
        }
      })
      .catch((reason: unknown) => {
        if (!mounted.current || request.current !== requestId) return;
        inFlight.current = false;
        setStatus("error");
        setError(reason instanceof Error ? reason.message : "Unable to create scratch chat");
      });
  }, [createChat, discardChat, navigation]);

  useEffect(() => {
    mounted.current = true;
    openChat();
    return () => {
      mounted.current = false;
      inFlight.current = false;
      request.current += 1;
    };
  }, [openChat]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 12,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      text: { color: theme.colors.foreground, textAlign: "center" as const },
      error: { color: theme.colors.statusDanger, textAlign: "center" as const },
      button: { padding: 12, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground },
    }),
    [layout.compact, theme],
  );

  return (
    <View style={styles.screen}>
      <Text style={status === "error" ? styles.error : styles.text}>
        {status === "loading" ? "Opening scratch chat…" : error}
      </Text>
      {status === "error" ? (
        <Pressable accessibilityRole="button" onPress={openChat} style={styles.button}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

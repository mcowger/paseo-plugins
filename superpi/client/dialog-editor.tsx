import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  initialDialogDraft,
  listPendingDialogsRpc,
  respondDialogRpc,
  type DialogAnswer,
  type DialogView,
} from "../shared/dialogs";

/**
 * Minimal plugin UI that retains native Pi editor `prefill`.
 *
 * The public host question card renders a text field but cannot seed it with an
 * initial value, so a native `editor` prefill cannot survive there. This screen
 * lists pending Superpi dialogs and renders `editor`/`input` fields as real
 * inputs whose initial value is the native prefill. Root wires it with
 * `client.addSettingsScreen` and the RPC handlers in `server/dialogs.ts`.
 */

const POLL_INTERVAL_MS = 1_000;

export function DialogEditorScreen({ theme, layout }: PluginSurfaceProps) {
  const listDialogs = useRpc(listPendingDialogsRpc);
  const respondDialog = useRpc(respondDialogRpc);
  const [dialogs, setDialogs] = useState<DialogView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const refreshRevision = useRef(0);

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    try {
      const result = await listDialogs({});
      if (!mounted.current || revision !== refreshRevision.current) return;
      setDialogs(result.dialogs);
      setDrafts((previous) => {
        let changed = false;
        const next: Record<string, string> = {};
        for (const dialog of result.dialogs) {
          const existing = previous[dialog.permissionId];
          if (existing === undefined) {
            next[dialog.permissionId] = initialDialogDraft(dialog);
            changed = true;
          } else {
            next[dialog.permissionId] = existing;
          }
        }
        if (!changed && Object.keys(previous).length === result.dialogs.length) return previous;
        return next;
      });
      setError(null);
      setLoading(false);
    } catch (caught) {
      if (mounted.current && revision === refreshRevision.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      }
    }
  }, [listDialogs]);

  useEffect(() => {
    mounted.current = true;
    setDialogs([]);
    setDrafts({});
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      refreshRevision.current += 1;
      clearInterval(timer);
    };
  }, [refresh]);

  const answer = useCallback(
    async (dialog: DialogView, response: DialogAnswer) => {
      setBusyId(dialog.permissionId);
      try {
        if (!dialog.generation) throw new Error("This dialog has no live session identity.");
        const result = await respondDialog({
          sessionId: dialog.sessionId,
          permissionId: dialog.permissionId,
          generation: dialog.generation,
          answer: response,
        });
        if (!result.resolved) throw new Error("This dialog is no longer available.");
        await refresh();
      } catch (caught) {
        if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mounted.current) setBusyId(null);
      }
    },
    [respondDialog, refresh],
  );

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 16,
      },
      heading: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 18 : 20,
        fontWeight: "600" as const,
      },
      empty: { color: theme.colors.foregroundMuted },
      card: {
        gap: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      },
      method: { color: theme.colors.foregroundMuted, fontSize: 12 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      message: { color: theme.colors.foregroundMuted },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        minHeight: 72,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
      },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      button: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonDisabled: { opacity: 0.5 },
      buttonText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      secondary: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      secondaryText: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  const renderControls = (dialog: DialogView) => {
    if (dialog.method === "select") {
      return (
        <View style={styles.row}>
          {(dialog.options ?? []).map((option) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityLabel={option}
              disabled={busyId !== null}
              onPress={() => void answer(dialog, { behavior: "allow", value: option })}
              style={busyId !== null ? [styles.button, styles.buttonDisabled] : styles.button}
            >
              <Text style={styles.buttonText}>{option}</Text>
            </Pressable>
          ))}
        </View>
      );
    }
    if (dialog.method === "confirm") {
      return (
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dialog.confirmLabel ?? "Confirm"}
            disabled={busyId !== null}
            onPress={() => void answer(dialog, { behavior: "allow", value: true })}
            style={busyId !== null ? [styles.button, styles.buttonDisabled] : styles.button}
          >
            <Text style={styles.buttonText}>{dialog.confirmLabel ?? "Confirm"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            disabled={busyId !== null}
            onPress={() => void answer(dialog, { behavior: "deny" })}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      );
    }
    const value = drafts[dialog.permissionId] ?? initialDialogDraft(dialog);
    const multiline = dialog.method === "editor";
    return (
      <View style={{ gap: 8 }}>
        <TextInput
          value={value}
          multiline={multiline}
          placeholder={dialog.placeholder ?? ""}
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={(text) =>
            setDrafts((previous) => ({ ...previous, [dialog.permissionId]: text }))
          }
          style={styles.input}
          accessibilityLabel={dialog.title}
        />
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Submit"
            disabled={busyId !== null}
            onPress={() => void answer(dialog, { behavior: "allow", value })}
            style={busyId !== null ? [styles.button, styles.buttonDisabled] : styles.button}
          >
            <Text style={styles.buttonText}>Submit</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            disabled={busyId !== null}
            onPress={() => void answer(dialog, { behavior: "deny" })}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Dismiss</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Pi dialogs</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading ? <ActivityIndicator color={theme.colors.accent} accessibilityLabel="Loading Pi dialogs" /> : null}
        {!loading && !error && dialogs.length === 0 ? (
          <Text style={styles.empty}>No pending Pi dialogs.</Text>
        ) : null}
        {dialogs.map((dialog) => (
          <View key={dialog.permissionId} style={styles.card}>
            <Text style={styles.method}>{dialog.method}</Text>
            <Text style={styles.title}>{dialog.title}</Text>
            {dialog.message ? <Text style={styles.message}>{dialog.message}</Text> : null}
            {renderControls(dialog)}
            {busyId === dialog.permissionId ? (
              <ActivityIndicator color={theme.colors.accent} />
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

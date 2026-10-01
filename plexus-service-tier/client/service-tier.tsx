import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  useAgent,
  usePaseo,
  type PluginButtonContentProps,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { agentTierState } from "./store";
import {
  hasServiceTierCommand,
  isServiceTierAgent,
  serviceTierInvocation,
  serviceTierLabel,
  serviceTierOptions,
  type ServiceTier,
} from "../shared/service-tier";

export function ServiceTierContent(props: PluginButtonContentProps) {
  const { theme, close, context } = props;
  const agentId = context === "agent" ? props.agentId : null;
  const paseo = usePaseo();
  const toast = useToast();
  const agent = useAgent(agentId ?? "", (value) => ({
    provider: value.provider,
    model: value.model,
  }));
  const [busy, setBusy] = useState<ServiceTier | null>(null);
  const [commandAvailable, setCommandAvailable] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);

  const state = agentId ? agentTierState.get(agentId) : undefined;
  const currentTier = state?.tier ?? "default";
  const provider = agent?.provider ?? state?.provider ?? "";
  const model = agent?.model ?? state?.model ?? null;
  const eligible = isServiceTierAgent(provider, model);
  const options = serviceTierOptions(provider, model);

  useEffect(() => {
    if (!agentId) {
      setCommandAvailable(false);
      return;
    }
    let cancelled = false;
    setCommandAvailable(null);
    paseo.agents
      .ref(agentId)
      .commands()
      .then((result) => {
        if (!cancelled) setCommandAvailable(hasServiceTierCommand(result.commands));
      })
      .catch(() => {
        if (!cancelled) setCommandAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, agentId, nonce]);

  const styles = useMemo(
    () => ({
      body: { gap: 10, minWidth: 260, maxWidth: 400 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      list: { gap: 6 },
      row: {
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      rowSelected: { backgroundColor: theme.colors.surface2 },
      rowLabel: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      rowDetail: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
      status: { color: theme.colors.foregroundMuted, fontSize: 13 },
      warning: { color: theme.colors.statusWarning, fontSize: 13 },
      retry: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      retryText: { color: theme.colors.foreground, fontSize: 13, textAlign: "center" as const },
    }),
    [theme],
  );

  async function select(tier: ServiceTier): Promise<void> {
    if (!agentId || busy !== null) return;
    if (!options.some((option) => option.id === tier)) return;
    setBusy(tier);
    try {
      await paseo.agents.ref(agentId).send(serviceTierInvocation(tier));
      if (state) {
        state.tier = tier;
        state.registration.update({ label: serviceTierLabel(tier) });
      }
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setBusy(null);
    }
  }

  function renderUnavailable() {
    return (
      <View style={{ gap: 8 }}>
        <Text style={styles.warning}>
          The active pi session does not expose /service-tier. Update the plexus-pi extension and
          reload pi, then retry.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry checking the service tier command"
          onPress={() => setNonce((value) => value + 1)}
          style={styles.retry}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <Text style={styles.title}>Service tier</Text>
      <Text style={styles.subtitle}>{eligible ? model : "Not available for this model."}</Text>
      {!eligible ? null : commandAvailable === false ? (
        renderUnavailable()
      ) : commandAvailable === null ? (
        <Text style={styles.status}>Checking session capabilities…</Text>
      ) : (
        <View style={styles.list}>
          {options.map((option) => {
            const selected = option.id === currentTier;
            const pending = busy === option.id;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityLabel={`Use the ${option.label} service tier`}
                accessibilityState={{ disabled: busy !== null, busy: pending, selected }}
                disabled={busy !== null}
                onPress={() => void select(option.id)}
                style={[styles.row, selected ? styles.rowSelected : null]}
              >
                <Text style={styles.rowLabel}>
                  {pending ? `Applying ${option.label}…` : option.label}
                </Text>
                <Text style={styles.rowDetail} numberOfLines={2}>
                  {option.description}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

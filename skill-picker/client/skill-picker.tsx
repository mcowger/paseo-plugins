import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { usePaseo, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { filterSkills, toSkillInvocation, type SkillCommand } from "../shared/skills";

export function SkillPickerContent(props: PluginButtonContentProps) {
  const { theme, layout, close } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const paseo = usePaseo();
  const toast = useToast();
  const [commands, setCommands] = useState<readonly SkillCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!agentId) {
      setLoading(false);
      setError("Skill picker is only available on an agent.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    paseo.agents
      .ref(agentId)
      .commands()
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setCommands([]);
          setError(result.error);
        } else {
          setCommands(result.commands ?? []);
          setError(null);
        }
        setLoading(false);
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return;
        setCommands([]);
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, agentId, nonce]);

  const skills = useMemo(() => filterSkills(commands, query), [commands, query]);

  const styles = useMemo(
    () => ({
      body: { gap: 12, minWidth: 280, maxWidth: 420 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      search: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 6 : 8,
        fontSize: 14,
      },
      list: { maxHeight: 320 },
      row: {
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      rowBusy: { opacity: 0.6 },
      rowName: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      rowDetail: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
      status: { color: theme.colors.foregroundMuted, fontSize: 13 },
      errorText: { color: theme.colors.statusDanger, fontSize: 13 },
      retry: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      retryText: { color: theme.colors.foreground, fontSize: 13, textAlign: "center" as const },
    }),
    [theme, layout.compact],
  );

  async function handleSelect(name: string) {
    if (sending !== null || !agentId) return;
    setSending(name);
    try {
      await paseo.agents.ref(agentId).send(toSkillInvocation(name));
      close();
    } catch (sendError: unknown) {
      toast.error(sendError instanceof Error ? sendError.message : String(sendError));
      setSending(null);
    }
  }

  function renderList() {
    if (loading) return <Text style={styles.status}>Loading skills…</Text>;
    if (error)
      return (
        <View style={{ gap: 8 }}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading skills"
            onPress={() => setNonce((value) => value + 1)}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      );
    if (skills.length === 0)
      return (
        <Text style={styles.status}>
          {query.trim() ? `No skills match “${query.trim()}”.` : "No skills loaded for this agent."}
        </Text>
      );
    return (
      <ScrollView style={styles.list}>
        <View style={{ gap: 6 }}>
          {skills.map((skill) => {
            const busy = sending !== null;
            const active = sending === skill.name;
            return (
              <Pressable
                key={skill.name}
                accessibilityRole="button"
                accessibilityLabel={`Invoke skill ${skill.name}`}
                accessibilityState={{ disabled: busy, busy: active }}
                disabled={busy}
                onPress={() => void handleSelect(skill.name)}
                style={[styles.row, busy ? styles.rowBusy : null]}
              >
                <Text style={styles.rowName}>{active ? `Sending /${skill.name}…` : `/${skill.name}`}</Text>
                {skill.description ? (
                  <Text style={styles.rowDetail} numberOfLines={2}>
                    {skill.description}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.body}>
      <Text style={styles.title}>Skills</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Filter skills…"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />
      {renderList()}
      <Text style={styles.hint}>Sends /name immediately — it does not fill the composer draft.</Text>
    </View>
  );
}

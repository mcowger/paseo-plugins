import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import {
  usePaseo,
  useSettings,
  type PluginButtonContentProps,
} from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { filterSkills, toSkillInvocation, type SkillCommand } from "../shared/skills";
import { recordSkillUsage, skillUsageSettings, sortSkillsByUsage } from "../shared/usage";

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
  const [highlighted, setHighlighted] = useState(0);
  const searchRef = useRef<TextInput>(null);
  const usage = useSettings(skillUsageSettings);
  const usageRef = useRef(usage);
  usageRef.current = usage;

  useEffect(() => {
    searchRef.current?.focus();
    const timer = setTimeout(() => {
      searchRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

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

  const skills = useMemo(() => {
    const filtered = filterSkills(commands, query);
    if (usage.status !== "ready") return filtered;
    return sortSkillsByUsage(filtered, usage.values);
  }, [commands, query, usage]);

  useEffect(() => {
    setHighlighted(0);
  }, [query, commands]);

  const activeIndex = skills.length === 0 ? 0 : Math.min(highlighted, skills.length - 1);

  const styles = useMemo(
    () => ({
      body: { gap: 12, minWidth: 280, maxWidth: 420 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      search: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 6 : 8,
        fontSize: 14,
      },
      list: { gap: 6 },
      row: {
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      rowBusy: { opacity: 0.6 },
      rowHighlighted: { backgroundColor: theme.colors.surface2 },
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

  async function persistUsage(name: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = usageRef.current;
      if (current.status !== "ready") return;
      const saved = await current.save(recordSkillUsage(current.values, name), current.revision);
      if (saved) return;
      if (attempt < 2) {
        await current.reload();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  async function handleSelect(name: string) {
    if (sending !== null || !agentId) return;
    setSending(name);
    try {
      await paseo.agents.ref(agentId).send(toSkillInvocation(name));
      void persistUsage(name);
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
      <View style={styles.list}>
        {skills.map((skill, index) => {
          const busy = sending !== null;
          const active = sending === skill.name;
          const isHighlighted = index === activeIndex;
          return (
            <Pressable
              key={skill.name}
              accessibilityRole="button"
              accessibilityLabel={`Invoke skill ${skill.name}`}
              accessibilityState={{ disabled: busy, busy: active, selected: isHighlighted }}
              disabled={busy}
              onPress={() => void handleSelect(skill.name)}
              style={[styles.row, isHighlighted ? styles.rowHighlighted : null, busy ? styles.rowBusy : null]}
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
    );
  }

  function handleKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    const key = event.nativeEvent.key;
    if (key === "ArrowDown") {
      setHighlighted((prev) => (skills.length === 0 ? 0 : (prev + 1) % skills.length));
    } else if (key === "ArrowUp") {
      setHighlighted((prev) =>
        skills.length === 0 ? 0 : (prev - 1 + skills.length) % skills.length,
      );
    } else if (key === "Enter") {
      const skill = skills[activeIndex];
      if (skill && sending === null) void handleSelect(skill.name);
    }
  }

  return (
    <View style={styles.body}>
      <Text style={styles.title}>Skills</Text>
      <TextInput
        ref={searchRef}
        value={query}
        onChangeText={setQuery}
        onKeyPress={handleKeyPress}
        placeholder="Filter skills…"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        style={styles.search}
      />
      {renderList()}
    </View>
  );
}

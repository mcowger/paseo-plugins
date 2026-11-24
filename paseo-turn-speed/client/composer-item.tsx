import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import { Pressable, Text } from "react-native";
import { useComposer, useComposers } from "@getpaseo/plugin/client";
import type { PluginHostProps, PluginComposer, PluginComposerItemProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import type { PillView } from "./pill";
import { matchComposer, type ComposerCandidate } from "./composer-match";

type Details = ComponentType<PluginHostProps>;
type Entry = { view: PillView; Details: Details; sent: string | null };

// Object key order is not significant for the JSON-valued composer settings.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type Candidate = ComposerCandidate;

function ComposerProbe({ agentId, report }: {
  agentId: string;
  report: (agentId: string, candidates: Candidate[] | null) => void;
}) {
  const composers = useComposers({ agentId });
  const signature = canonical(composers.map((composer) => ({
    context: composer.context,
    prompt: composer.prompt,
    agent: canonical(composer.agent),
  })));
  useEffect(() => {
    report(agentId, JSON.parse(signature) as Candidate[]);
  }, [agentId, report, signature]);
  useEffect(() => () => report(agentId, null), [agentId, report]);
  return null;
}

export function createComposerItems() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let disposed = false;
  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const snapshot = () => revision;

  function BoundItem({ hostProps, composer, ids }: {
    hostProps: PluginComposerItemProps;
    composer: PluginComposer;
    ids: string[];
  }) {
    const [candidates, setCandidates] = useState<Record<string, Candidate[]>>({});
    const [open, setOpen] = useState(false);
    const retained = useRef<string | null>(null);
    const report = useCallback((agentId: string, next: Candidate[] | null) => {
      setCandidates((previous) => {
        if (next === null) {
          if (!(agentId in previous)) return previous;
          const copy = { ...previous };
          delete copy[agentId];
          return copy;
        }
        if (canonical(previous[agentId]) === canonical(next)) return previous;
        return { ...previous, [agentId]: next };
      });
    }, []);
    const signature = canonical(composer.agent);
    const selected = matchComposer(
      { context: composer.context, prompt: composer.prompt, agent: signature },
      ids,
      candidates,
      new Map(ids.map((id) => [id, entries.get(id)?.sent ?? null])),
      retained.current,
    );
    if (selected !== null) retained.current = selected;
    else if (composer.prompt !== "") retained.current = null;
    const entry = selected === null ? undefined : entries.get(selected);
    const Content = entry?.Details;

    return <>
      {ids.map((id) => <ComposerProbe key={id} agentId={id} report={report} />)}
      {entry?.view.visible && selected && Content ? <>
        <Pressable accessibilityRole="button" accessibilityLabel={entry.view.title} onPress={() => setOpen(true)}>
          <Text style={{ color: hostProps.theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{entry.view.label}</Text>
        </Pressable>
        <Modal key={selected} title={entry.view.title} open={open} onOpenChange={setOpen}>
          <Modal.Content>
            <Content {...hostProps} />
          </Modal.Content>
        </Modal>
      </> : null}
    </>;
  }

  function Component(props: PluginComposerItemProps) {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    const composer = useComposer();
    if (composer.context !== "agent") return null;
    return <BoundItem key={`${props.host.id}:${composer.context}`} hostProps={props} composer={composer} ids={[...entries.keys()]} />;
  }

  return {
    Component,
    register(agentId: string, initial: PillView, Details: Details) {
      const entry: Entry = { view: initial, Details, sent: null };
      if (!disposed) { entries.set(agentId, entry); notify(); }
      return {
        update(view: PillView) {
          if (entries.get(agentId) !== entry) return;
          entry.view = view;
          notify();
        },
        remove() {
          if (entries.get(agentId) !== entry) return;
          entries.delete(agentId);
          notify();
        },
      };
    },
    sent(agentId: string, text: string) {
      const entry = entries.get(agentId);
      if (!entry) return;
      entry.sent = text;
      notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      entries.clear();
      notify();
      listeners.clear();
    },
  };
}

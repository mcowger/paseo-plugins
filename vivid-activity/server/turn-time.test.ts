import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { planFolds, roleSignature } from "../shared/fold";
import { indexRowFromWire, wirePageFromEntries } from "../shared/fold-index";
import { DEFAULT_EXPANSION } from "../shared/settings";
import { TURN_TIME_RENDERER_KIND } from "../shared/turn-time";
import { TurnTimePublisher } from "./turn-time";

type Appended = { agentId: string; item: { id: string; kind: string; data: { at: number; turnId: string | null; outcome: string } } };

function values(turnTime: boolean) {
  return { takeover: "all" as const, palette: "vivid" as const, expansion: DEFAULT_EXPANSION, fold: true, density: "compact" as const, turnTime };
}

function harness(turnTime: boolean) {
  const appended: Appended[] = [];
  const settings = {
    read: async () => ({ status: "ready" as const, revision: "r", values: values(turnTime) }),
    subscribe: () => () => undefined,
  };
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        timeline: {
          append: async (item: Appended["item"]) => {
            appended.push({ agentId, item });
            return { seq: appended.length, epoch: "e" };
          },
        },
      }),
    },
  };
  return { appended, settings, paseo };
}

function ended(turnId: string | null = "t1", kind: "completed" | "failed" | "canceled" = "completed"): PluginLifecycleEvents["agent.turn_ended"] {
  const outcome =
    kind === "failed"
      ? ({ kind: "failed", error: { message: "boom" } } as const)
      : kind === "canceled"
        ? ({ kind: "canceled", reason: "stopped" } as const)
        : ({ kind: "completed" } as const);
  return {
    agent: { id: "a1", workspaceId: null, parentAgentId: null, provider: "codex", cwd: "/tmp", title: null },
    turnId,
    outcome,
    timeline: [],
  };
}

describe("TurnTimePublisher", () => {
  it("appends one row at the end of a finished turn", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended(), { paseo } as never);

    expect(appended).toHaveLength(1);
    expect(appended[0]!.agentId).toBe("a1");
    expect(appended[0]!.item.kind).toBe(TURN_TIME_RENDERER_KIND);
    expect(appended[0]!.item.data.outcome).toBe("completed");
    expect(appended[0]!.item.data.turnId).toBe("t1");
    expect(appended[0]!.item.data.at).toBeGreaterThan(0);
  });

  it("writes one row per turn", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended("t1"), { paseo } as never);
    await publisher.finish(ended("t2"), { paseo } as never);

    expect(appended).toHaveLength(2);
    expect(appended.map((entry) => entry.item.data.turnId)).toEqual(["t1", "t2"]);
    expect(new Set(appended.map((entry) => entry.item.id)).size).toBe(2);
  });

  it("carries the failure outcome", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended("t1", "failed"), { paseo } as never);

    expect(appended[0]!.item.data.outcome).toBe("failed");
  });

  it("writes nothing when the setting is off", async () => {
    const { appended, settings, paseo } = harness(false);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended(), { paseo } as never);

    expect(appended).toEqual([]);
  });

  it("keeps a readable id for a turn without a turn id", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended(null), { paseo } as never);

    expect(appended).toHaveLength(1);
    expect(appended[0]!.item.id).toBe(`turn-end-${appended[0]!.item.data.at}`);
  });
});

/** A promise the test settles by hand: the order of every step below is fixed, no timers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every pending continuation run (the publisher's awaits) before the next step. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

type SettingsState = { status: "ready"; revision: string; values: ReturnType<typeof values> };

describe("TurnTimePublisher and the next turn", () => {
  it("writes nothing for a turn once the agent began its next turn while the switch was still being read", async () => {
    const { appended, paseo } = harness(true);
    const read = deferred<SettingsState>();
    const publisher = new TurnTimePublisher({ read: () => read.promise, subscribe: () => () => undefined } as never);
    publisher.start();

    const finishing = publisher.finish(ended("t1"), { paseo } as never);
    publisher.started("a1");
    read.resolve({ status: "ready", revision: "r", values: values(true) });
    await finishing;

    // Written now, the row of t1 would land among t2's rows.
    expect(appended).toEqual([]);
  });

  it("still writes when only another agent began a turn meanwhile", async () => {
    const { appended, paseo } = harness(true);
    const read = deferred<SettingsState>();
    const publisher = new TurnTimePublisher({ read: () => read.promise, subscribe: () => () => undefined } as never);
    publisher.start();

    const finishing = publisher.finish(ended("t1"), { paseo } as never);
    publisher.started("a2");
    read.resolve({ status: "ready", revision: "r", values: values(true) });
    await finishing;

    expect(appended.map((entry) => entry.item.data.turnId)).toEqual(["t1"]);
  });

  it("writes the next turn's own row after it ends", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await settle();

    publisher.started("a1");
    await publisher.finish(ended("t1"), { paseo } as never);
    publisher.started("a1");
    await publisher.finish(ended("t2"), { paseo } as never);

    expect(appended.map((entry) => entry.item.data.turnId)).toEqual(["t1", "t2"]);
  });

  it("does not let a first read that answers after a change notification undo it", async () => {
    const { appended, paseo } = harness(true);
    const read = deferred<SettingsState>();
    let notify: ((state: SettingsState) => void) | null = null;
    const publisher = new TurnTimePublisher({
      read: () => read.promise,
      subscribe: (listener: (state: SettingsState) => void) => {
        notify = listener;
        return () => undefined;
      },
    } as never);
    publisher.start();

    notify!({ status: "ready", revision: "r2", values: values(true) });
    // The read went out before the switch was turned on and comes back with the old value.
    read.resolve({ status: "ready", revision: "r1", values: values(false) });
    await settle();
    await publisher.finish(ended("t1"), { paseo } as never);

    expect(appended).toHaveLength(1);
  });
});

/**
 * The host's projected timeline of one agent, in the order the host commits entries. `write` stamps each entry one second
 * after the previous one. Appended plugin rows get `markerTurn` as their turn id (the host's choice is not documented).
 */
function hostTimeline(markerTurn: string | undefined) {
  const entries: Array<Record<string, unknown>> = [];
  let clock = Date.parse("2026-11-06T09:00:00.000Z");
  const write = (turnId: string | undefined, item: Record<string, unknown>) => {
    const seq = entries.length + 1;
    clock += 1000;
    entries.push({ provider: "claude", seqStart: seq, seqEnd: seq, timestamp: new Date(clock).toISOString(), ...(turnId ? { turnId } : {}), item });
  };
  const command = (callId: string) => ({ type: "tool_call", callId, name: "Bash", status: "completed", error: null, detail: { type: "shell", command: `echo ${callId}` } });
  const pending: Array<{ item: Record<string, unknown>; done: () => void }> = [];
  const paseo = {
    agents: {
      ref: () => ({
        timeline: {
          // The append request is on its way; the host commits it only when the test says so (`commit`).
          append: (item: Record<string, unknown>) =>
            new Promise<{ seq: number; epoch: string }>((resolve) => {
              pending.push({ item: { ...item, pluginId: "vivid-activity" }, done: () => resolve({ seq: entries.length, epoch: "e" }) });
            }),
        },
      }),
    },
  };
  const commit = () => {
    for (const { item, done } of pending.splice(0)) {
      write(markerTurn, item);
      done();
    }
  };
  return { entries, write, command, paseo, commit, pending };
}

function plan(entries: ReadonlyArray<Record<string, unknown>>, agentRunning: boolean) {
  const { rows, turns } = wirePageFromEntries(entries, () => null);
  const { roles, segments } = planFolds(rows.map((row) => indexRowFromWire(row, turns)), { scope: "all", enabled: true, agentRunning });
  return { segments, roles: [...roles].map(([key, role]) => [key, roleSignature(role)]) };
}

describe("a late turn-end row and the next turn's folds", () => {
  for (const markerTurn of ["t2", "t1", undefined]) {
    it(`leaves the next turn's run in one fold when the row is committed in the middle of it (row turn: ${markerTurn ?? "none"})`, async () => {
      const host = hostTimeline(markerTurn);
      const { settings } = harness(true);
      const publisher = new TurnTimePublisher(settings as never);
      publisher.start();
      await settle();

      host.write("t1", { type: "user_message", text: "first" });
      host.write("t1", { type: "assistant_message", text: "done" });
      // Settings are ready: the row's append goes out at once, but the host has not committed it yet.
      const finishing = publisher.finish(ended("t1"), { paseo: host.paseo } as never);
      await settle();
      expect(host.pending).toHaveLength(1);
      publisher.started("a1");
      host.write("t2", { type: "user_message", text: "second" });
      host.write("t2", host.command("c1"));
      host.write("t2", host.command("c2"));
      host.commit();
      await finishing;
      host.write("t2", host.command("c3"));
      host.write("t2", host.command("c4"));

      // The scenario really happened: t1's row sits between t2's second and third command.
      const kinds = host.entries.map((entry) => (entry.item as { kind?: string; callId?: string; type: string }).kind ?? (entry.item as { callId?: string }).callId ?? (entry.item as { type: string }).type);
      expect(kinds).toEqual(["user_message", "assistant_message", "user_message", "c1", "c2", TURN_TIME_RENDERER_KIND, "c3", "c4"]);

      const without = host.entries.filter((entry) => (entry.item as { kind?: string }).kind !== TURN_TIME_RENDERER_KIND);
      for (const running of [false, true]) {
        // Same segments, same summary (steps, counts, duration, end time) as if the row did not exist.
        expect(plan(host.entries, running)).toEqual(plan(without, running));
      }
      const finished = plan(host.entries, false);
      expect(finished.segments).toEqual([
        { id: "4", keys: ["t:c1", "t:c2", "t:c3", "t:c4"], sealed: true, running: false, mode: "done", anchor: "t:c1" },
      ]);
    });
  }
});

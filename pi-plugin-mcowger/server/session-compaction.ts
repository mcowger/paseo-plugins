import { randomUUID } from "node:crypto";

import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import type { PiSessionState } from "./rpc-types.js";

export type PiCompactionTrigger = "auto" | "manual";
export type PiCompactionStatus = "loading" | "completed";
export type PiCompactionOutcome = "completed" | "error" | "canceled" | "retry" | "skipped";
export type PiAutoCompactMode = boolean | "toggle" | "unknown";

export interface PiCompactionSink {
  timeline(item: ProviderTimelineItem): void;
  refreshUsage?(): void;
}

export interface PiAutoCompactRuntime {
  getState(): Promise<PiSessionState>;
  setAutoCompaction(enabled: boolean): Promise<void>;
}

export type PiAutoCompactResult =
  | { ok: true; enabled: boolean; message: string }
  | { ok: false; kind: "usage" | "unavailable" | "failed"; message: string };

interface ActiveCompaction {
  id: string;
  trigger: PiCompactionTrigger;
}

interface ManualCompactionCommand {
  clientMessageId: string;
  started: boolean;
  completed: boolean;
  outcome: PiCompactionOutcome | null;
}

// Port of upstream `parseAutoCompactMode` in
// `~/workspace/paseo/packages/server/src/server/agent/providers/pi/agent.ts`.
// Accepts the same on/off synonyms; bare `/autocompact` toggles.
export function parseAutoCompactMode(value: string | undefined): PiAutoCompactMode {
  const mode = (value ?? "toggle").trim().toLowerCase();
  if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") {
    return true;
  }
  if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") {
    return false;
  }
  if (mode === "toggle") {
    return "toggle";
  }
  return "unknown";
}

// Small owner for compaction trigger state, manual `/compact` command
// ownership, and `/autocompact` mode resolution. Mirrors upstream
// `executeCompactCommand` / `executeAutoCompactCommand` in `agent.ts` and the
// `emitCompactionTimeline` out-of-band lifecycle, adapted to the plugin's
// provider timeline (stable item id, exactly-one terminal transition).
export class PiSessionCompaction {
  private active: ActiveCompaction | null = null;
  private manual: ManualCompactionCommand | null = null;

  constructor(
    private readonly sink: PiCompactionSink,
    private readonly mintId: () => string = () => `compaction:${randomUUID()}`,
  ) {}

  get activeCompaction(): ActiveCompaction | null {
    return this.active ? { ...this.active } : null;
  }

  get manualCommand(): ManualCompactionCommand | null {
    return this.manual ? { ...this.manual } : null;
  }

  isManualActive(): boolean {
    return this.manual !== null;
  }

  beginManual(clientMessageId: string): void {
    if (this.manual) {
      throw new Error("A Pi compact command is already running");
    }
    this.manual = { clientMessageId, started: false, completed: false, outcome: null };
  }

  recordOutcome(outcome: PiCompactionOutcome): void {
    if (this.manual) {
      this.manual.outcome = outcome;
    }
  }

  endManual(): void {
    this.manual = null;
  }

  handleEvent(status: PiCompactionStatus, trigger: PiCompactionTrigger): void {
    if (status === "loading") {
      // First trigger wins so a loading/completed pair shares one stable id.
      const active = this.active ?? { id: this.mintId(), trigger };
      this.active = active;
      if (this.manual && trigger === "manual") {
        this.manual.started = true;
      }
      this.sink.timeline({
        type: "compaction",
        id: active.id,
        status,
        trigger: active.trigger,
      });
      return;
    }
    // Duplicate terminal for an already-completed manual command: ignore so
    // each compaction emits exactly one completed transition.
    if (!this.active && this.manual?.completed) {
      return;
    }
    const active = this.active ?? { id: this.mintId(), trigger };
    if (this.manual && trigger === "manual" && !this.manual.completed) {
      this.manual.completed = true;
      this.manual.outcome = this.manual.outcome ?? "completed";
    }
    this.sink.timeline({
      type: "compaction",
      id: active.id,
      status,
      trigger: active.trigger,
    });
    this.active = null;
    this.sink.refreshUsage?.();
  }

  // Close a manual loading item when `runtime.compact()` rejects after
  // `compaction_start` was already observed. Returns true when a terminal
  // transition was emitted. Ports the `executeCompactCommand` catch path.
  completeManualAfterFailure(): boolean {
    const manual = this.manual;
    if (manual && manual.started && !manual.completed) {
      manual.outcome = "error";
      this.handleEvent("completed", "manual");
      return true;
    }
    if (manual && !manual.completed) {
      manual.outcome = "error";
    }
    return false;
  }

  // Port of upstream `executeAutoCompactCommand`: invalid args fail visibly
  // with usage text, bare/toggle re-reads native RPC state, and an
  // unavailable state fails visibly instead of toggling blindly.
  async runAutoCompact(
    mode: string | undefined,
    runtime: PiAutoCompactRuntime,
  ): Promise<PiAutoCompactResult> {
    let enabled = parseAutoCompactMode(mode);
    if (enabled === "unknown") {
      return {
        ok: false,
        kind: "usage",
        message: "[Error] Usage: /autocompact [on|off|toggle]",
      };
    }
    if (enabled === "toggle") {
      // `getState()` is guarded like the setter below: a rejected state
      // read must surface a visible failure instead of escaping `prompt()`
      // with no `session.prompt_result` (which would hang the client).
      let state: PiSessionState | undefined;
      try {
        state = await runtime.getState();
      } catch {
        state = undefined;
      }
      if (!state || typeof state.autoCompactionEnabled !== "boolean") {
        return {
          ok: false,
          kind: "unavailable",
          message:
            "[Error] Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
        };
      }
      enabled = !state.autoCompactionEnabled;
    }
    try {
      await runtime.setAutoCompaction(enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        kind: "failed",
        message: `[Error] Failed to set auto-compaction: ${message}`,
      };
    }
    return {
      ok: true,
      enabled,
      message: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
    };
  }
}

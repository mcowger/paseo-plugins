import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

export interface SubagentDescription {
  parentId?: string;
  toolCallId?: string;
  title?: string;
  description?: string;
}

interface ChildSession extends SubagentDescription {
  opened: boolean;
  finished: boolean;
}

export class ProviderSubagentProjector {
  private readonly children = new Map<string, ChildSession>();

  constructor(
    private readonly sourceId: string,
    private readonly rootSessionId: string,
    private readonly cwd: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  sessionId(id: string): string {
    return `${this.sourceId}:${id}`;
  }

  describe(id: string, change: SubagentDescription): void {
    const child = this.child(id);
    Object.assign(child, { ...change, ...(change.parentId === id ? { parentId: undefined } : {}) });
    this.open(id, child);
  }

  timeline(id: string, item: ProviderTimelineItem, resumeTurn = true): void {
    const child = this.child(id);
    this.open(id, child);
    if (child.finished && resumeTurn) {
      child.finished = false;
      this.emit({ type: "session.turn", sessionId: this.sessionId(id), turnId: id, state: "started" });
    }
    this.emit({ type: "timeline.item", sessionId: this.sessionId(id), item });
  }

  finish(id: string, state: "completed" | "failed" | "canceled" = "completed", error?: string): void {
    const child = this.child(id);
    this.open(id, child);
    if (child.finished) return;
    child.finished = true;
    this.emit({
      type: "session.turn", sessionId: this.sessionId(id), turnId: id, state,
      ...(state === "failed" ? { error: { message: error ?? "Subagent failed" } } : {}),
    });
  }

  close(): void {
    for (const [id, child] of this.children) {
      if (child.opened) this.emit({ type: "session.closed", sessionId: this.sessionId(id) });
    }
    this.children.clear();
  }

  private child(id: string): ChildSession {
    let child = this.children.get(id);
    if (!child) {
      child = { opened: false, finished: false };
      this.children.set(id, child);
    }
    return child;
  }

  private open(id: string, child: ChildSession): void {
    if (child.opened) return;
    if (child.parentId) this.open(child.parentId, this.child(child.parentId));
    this.emit({
      type: "session.opened",
      sessionId: this.sessionId(id),
      parentSessionId: child.parentId ? this.sessionId(child.parentId) : this.rootSessionId,
      ...(child.toolCallId ? { toolCallId: child.toolCallId } : {}),
      capabilities: [],
      restoration: "parent",
      title: child.title ?? "Pi subagent",
      ...(child.description ? { description: child.description } : {}),
      cwd: this.cwd,
    });
    child.opened = true;
    this.emit({ type: "session.ready", sessionId: this.sessionId(id) });
    this.emit({ type: "session.turn", sessionId: this.sessionId(id), turnId: id, state: "started" });
  }
}

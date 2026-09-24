import type { ProviderEvent, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

import type { PiSessionEntry } from "./rpc-types.js";
import { SuperAgentSubagents } from "./super-agent-subagents.js";
import { WjSubagents } from "./wj-subagents.js";

export interface SubagentSource {
  handlesTool(name: string): boolean;
  toolDetail(name: string, args: unknown, result: unknown): ProviderToolCallDetail | null;
  rootToolStart(callId: string, name: string, args: unknown): void;
  rootToolEnd(callId: string, name: string, result: unknown): void;
  handlesCustomMessage(customType: string | undefined): boolean;
  custom(customType: string | undefined, content: unknown): boolean;
  activityEntry(entry: PiSessionEntry): void;
  beginReplay?(): void;
  endReplay?(): void;
  close(): void;
}

export interface SubagentSourceContext {
  sessionId: string;
  cwd: string;
  emit(event: ProviderEvent): void;
}

export interface SubagentSourceDefinition {
  matches(toolNames: ReadonlySet<string>): boolean;
  create(context: SubagentSourceContext): SubagentSource;
}

const SOURCE_DEFINITIONS: readonly SubagentSourceDefinition[] = [
  {
    matches: (names) => WjSubagents.isAvailable([...names]),
    create: (context) => new WjSubagents(context.sessionId, context.cwd, context.emit),
  },
  {
    matches: (names) => SuperAgentSubagents.isAvailable(names),
    create: (context) => new SuperAgentSubagents(context.sessionId, context.cwd, context.emit),
  },
];

export class PiSubagentSources {
  private constructor(private readonly sources: readonly SubagentSource[]) {}

  static fromProbe(
    rawTools: unknown,
    context: SubagentSourceContext,
    definitions: readonly SubagentSourceDefinition[] = SOURCE_DEFINITIONS,
  ): PiSubagentSources | null {
    if (!Array.isArray(rawTools)) return null;
    const names = new Set<string>();
    for (const tool of rawTools) {
      if (typeof tool === "string") names.add(tool);
      else if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") names.add(tool.name);
    }
    const sources = definitions.filter((definition) => definition.matches(names)).map((definition) => definition.create(context));
    return sources.length > 0 ? new PiSubagentSources(sources) : null;
  }

  toolDetail(name: string, args: unknown, result: unknown): ProviderToolCallDetail | null {
    const source = this.sources.find((candidate) => candidate.handlesTool(name));
    return source?.toolDetail(name, args, result) ?? null;
  }

  rootToolStart(callId: string, name: string, args: unknown): void {
    this.sources.find((source) => source.handlesTool(name))?.rootToolStart(callId, name, args);
  }

  rootToolEnd(callId: string, name: string, result: unknown): void {
    this.sources.find((source) => source.handlesTool(name))?.rootToolEnd(callId, name, result);
  }

  handlesCustomMessage(customType: string | undefined): boolean {
    return this.sources.some((source) => source.handlesCustomMessage(customType));
  }

  custom(customType: string | undefined, content: unknown): boolean {
    const source = this.sources.find((candidate) => candidate.handlesCustomMessage(customType));
    return source?.custom(customType, content) ?? false;
  }

  activityEntry(entry: PiSessionEntry): void {
    for (const source of this.sources) source.activityEntry(entry);
  }

  beginReplay(): void {
    for (const source of this.sources) source.beginReplay?.();
  }

  endReplay(): void {
    for (const source of this.sources) source.endReplay?.();
  }

  close(): void {
    for (const source of this.sources) source.close();
  }
}

import { homedir } from "node:os";

import type { PiAgentSessionLike, PiModelRuntimeLike, PiResourceLoaderLike, PiSessionManagerLike, PiToolDefinition } from "../shared/pi-sdk-types.js";
import { createPiTodoTool, hasPiTodoExtensionTool, PI_TODO_TOOL_NAME } from "./pi-todo-tool.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "./pi-sdk.js";

const MAX_DISCOVERED_TOOLS = 512;
const MAX_TEXT_LENGTH = 400;

export interface PiKnownTool {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "fallback";
  baselineActive: boolean;
}

interface PiToolLike {
  name: string;
  description?: unknown;
}

export interface PiToolDiscoveryDependencies {
  createAgentSession: (options: {
    cwd: string;
    modelRuntime: PiModelRuntimeLike;
    resourceLoader: PiResourceLoaderLike;
    sessionManager: PiSessionManagerLike;
    customTools?: PiToolDefinition[];
  }) => Promise<{ session: PiAgentSessionLike }>;
  createModelRuntime: () => Promise<PiModelRuntimeLike>;
  createResourceLoader: (options: { cwd: string; agentDir: string }) => PiResourceLoaderLike;
  createSessionManager: (cwd: string) => PiSessionManagerLike;
  getAgentDir: () => string;
}

function truncate(value: string): string {
  return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

function toolDetails(tool: unknown): PiToolLike | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  const value = tool as { name?: unknown; description?: unknown };
  return typeof value.name === "string" && value.name.trim()
    ? { name: value.name, description: value.description }
    : null;
}

function extensionToolNames(loader: PiResourceLoaderLike): Set<string> {
  const names = new Set<string>();
  for (const extension of loader.getExtensions().extensions) {
    for (const name of extension.tools.keys()) names.add(name);
  }
  return names;
}

const defaultDependencies: PiToolDiscoveryDependencies = {
  createAgentSession: async (options) => createAgentSession(options),
  createModelRuntime: () => ModelRuntime.create(),
  createResourceLoader: (options) => new DefaultResourceLoader(options),
  createSessionManager: (cwd) => SessionManager.inMemory(cwd),
  getAgentDir,
};

/**
 * Discovers globally loaded Pi tools for policy presentation without opening a
 * Paseo agent. The temporary in-memory session is always disposed.
 */
export async function discoverGlobalPiTools(
  options: { cwd?: string; dependencies?: Partial<PiToolDiscoveryDependencies> } = {},
): Promise<PiKnownTool[]> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const cwd = options.cwd ?? homedir();
  const loader = dependencies.createResourceLoader({ cwd, agentDir: dependencies.getAgentDir() });
  let session: PiAgentSessionLike | undefined;

  try {
    await loader.reload();
    const sessionManager = dependencies.createSessionManager(cwd);
    const extensions = loader.getExtensions();
    const hasExtensionTodoTool = hasPiTodoExtensionTool(extensions);
    const customTools = hasExtensionTodoTool ? [] : [createPiTodoTool(sessionManager)];
    const created = await dependencies.createAgentSession({
      cwd,
      modelRuntime: await dependencies.createModelRuntime(),
      resourceLoader: loader,
      sessionManager,
      ...(customTools.length > 0 ? { customTools } : {}),
    });
    session = created.session;

    const active = new Set(session.getActiveToolNames());
    const extensionNames = extensionToolNames(loader);
    const tools: PiKnownTool[] = [];
    for (const candidate of session.getAllTools()) {
      if (tools.length >= MAX_DISCOVERED_TOOLS) break;
      const tool = toolDetails(candidate);
      if (!tool) continue;
      const name = tool.name.trim();
      tools.push({
        name,
        ...(typeof tool.description === "string"
          ? { description: truncate(tool.description) }
          : {}),
        source: name === PI_TODO_TOOL_NAME && !hasExtensionTodoTool
          ? "fallback"
          : extensionNames.has(name)
            ? "extension"
            : "builtin",
        baselineActive: active.has(name),
      });
    }
    if (
      tools.length < MAX_DISCOVERED_TOOLS &&
      !hasExtensionTodoTool &&
      !tools.some((tool) => tool.name === PI_TODO_TOOL_NAME)
    ) {
      tools.push({
        name: PI_TODO_TOOL_NAME,
        description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
        source: "fallback",
        baselineActive: active.has(PI_TODO_TOOL_NAME),
      });
    }
    return tools;
  } finally {
    session?.dispose();
  }
}

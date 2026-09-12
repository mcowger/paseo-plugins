import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { CreateScratchChatResult } from "../shared/create-scratch-chat.js";
import { selectProviderModel } from "../shared/provider-selection.js";

const TEMP_PREFIX = "paseo-scratch-chat-";

export interface ScratchChatResources {
  agentId: string | null;
  workspaceId: string;
  directory: string;
  cleanupPromise?: Promise<boolean>;
}

export function createScratchChatResources() {
  const resources = new Map<string, ScratchChatResources>();
  return {
    add(resource: ScratchChatResources) {
      resources.set(resource.workspaceId, resource);
    },
    getAgent(agentId: string) {
      return [...resources.values()].find((resource) => resource.agentId === agentId);
    },
    getWorkspace(workspaceId: string) {
      return resources.get(workspaceId);
    },
    setAgent(resource: ScratchChatResources, agentId: string) {
      resource.agentId = agentId;
    },
    remove(resource: ScratchChatResources) {
      resources.delete(resource.workspaceId);
    },
    values() {
      return resources.values();
    },
  };
}

export type ScratchChatResourceStore = ReturnType<typeof createScratchChatResources>;

export async function createScratchChat(
  _input: Record<string, never>,
  { paseo }: PluginHandlerContext,
  resources: ScratchChatResourceStore,
): Promise<CreateScratchChatResult> {
  const directory = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  let resource: ScratchChatResources | undefined;
  try {
    const snapshot = await paseo.providers.waitForReady();
    const providerModel = selectProviderModel(snapshot.entries);
    if (!providerModel) {
      throw new Error("No selectable provider model is available for Scratch Chat");
    }

    const workspace = await paseo.workspaces.create({
      title: "Scratch Chat",
      source: { kind: "directory", path: directory },
    });
    resource = { agentId: null, workspaceId: workspace.id, directory };
    resources.add(resource);

    const agent = await workspace.agents.create({
      config: { provider: providerModel },
      title: "Scratch Chat",
      labels: { "scratch-chat": "true" },
    });
    resources.setAgent(resource, agent.id);
    return { workspaceId: workspace.id, agentId: agent.id };
  } catch (error) {
    if (resource) await cleanupScratchChat(resource, paseo, resources).catch(() => undefined);
    else await removeScratchDirectory(directory).catch(() => undefined);
    throw error;
  }
}

export async function discardScratchChat(
  agentId: string,
  { paseo }: PluginHandlerContext,
  resources: ScratchChatResourceStore,
): Promise<{ agentId: string; workspaceId: string }> {
  const resource = resources.getAgent(agentId);
  if (!resource || resource.agentId === null) throw new Error("Scratch Chat agent not found");
  if (!(await cleanupScratchChat(resource, paseo, resources))) {
    throw new Error("Could not fully discard Scratch Chat; it remains tracked for retry");
  }
  return { agentId, workspaceId: resource.workspaceId };
}

export async function removeScratchDirectory(directory: string): Promise<void> {
  const resolvedDirectory = path.resolve(directory);
  const resolvedTempDirectory = path.resolve(tmpdir());
  if (
    path.dirname(resolvedDirectory) !== resolvedTempDirectory ||
    !path.basename(resolvedDirectory).startsWith(TEMP_PREFIX)
  ) {
    return;
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
}

export function cleanupScratchChat(
  resource: ScratchChatResources,
  paseo: PluginHandlerContext["paseo"],
  resources: ScratchChatResourceStore,
  options: { skipAgent?: boolean; skipWorkspace?: boolean } = {},
): Promise<boolean> {
  if (resource.cleanupPromise) return resource.cleanupPromise;
  resource.cleanupPromise = (async () => {
    let success = true;
    if (resource.agentId && !options.skipAgent) {
      try {
        await paseo.agents.ref(resource.agentId).archive();
      } catch {
        success = false;
      }
    }
    if (!options.skipWorkspace) {
      try {
        await paseo.workspaces.ref(resource.workspaceId).archive();
      } catch {
        success = false;
      }
    }
    if (!success) return false;

    try {
      await removeScratchDirectory(resource.directory);
    } catch {
      return false;
    }
    resources.remove(resource);
    return true;
  })();
  void resource.cleanupPromise.then((success) => {
    if (!success) resource.cleanupPromise = undefined;
  });
  return resource.cleanupPromise;
}

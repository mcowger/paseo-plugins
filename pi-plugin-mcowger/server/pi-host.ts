import { homedir } from "node:os";

import type { ProviderCatalog, ProviderModel } from "@getpaseo/plugin/server/provider";

import type { PiModel } from "../shared/rpc-types.js";
import type { PiModelRuntimeLike } from "../shared/pi-sdk-types.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "./pi-sdk.js";
import { mapPiModel } from "./thinking.js";

/**
 * Create the shared model runtime, then run a one-time warmup session so
 * extension-registered providers (e.g. plexus from ~/.pi/agent/extensions)
 * register into the runtime registry. Without a session having loaded user
 * extensions, getAvailable()/getModel() only see built-in providers.
 * Registrations persist after the warmup session is disposed.
 */
export async function createModelRuntime(): Promise<PiModelRuntimeLike> {
  const runtime = await ModelRuntime.create();
  const loader = new DefaultResourceLoader({ cwd: homedir(), agentDir: getAgentDir() });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: homedir(),
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(homedir()),
    resourceLoader: loader,
  });
  session.dispose();
  return runtime;
}

export async function listCatalogModels(
  modelRuntime: PiModelRuntimeLike,
): Promise<ProviderModel[]> {
  const available = await modelRuntime.getAvailable();
  return available.map((model: unknown) => mapPiModel(model as PiModel));
}

export async function buildCatalog(
  modelRuntime: PiModelRuntimeLike,
): Promise<ProviderCatalog> {
  return {
    models: await listCatalogModels(modelRuntime),
    modes: [],
  };
}

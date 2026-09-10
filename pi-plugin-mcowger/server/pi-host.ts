import { homedir } from "node:os";

import type { ProviderCatalog, ProviderModel } from "@getpaseo/plugin/server/provider";

import type { PiModel } from "../shared/rpc-types.js";
import type { PiModelRuntimeLike } from "../shared/pi-sdk-types.js";
import { modelMatchesPatterns, readPiUserSettings } from "./pi-settings.js";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "./pi-sdk.js";
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

/**
 * Authenticated models scoped by pi's settings (enabledProviders /
 * enabledModels). Raw pi model shapes, thinkingLevelMap included.
 */
export async function listScopedModels(
  modelRuntime: PiModelRuntimeLike,
  cwd?: string,
): Promise<PiModel[]> {
  const settings = readPiUserSettings(cwd ?? homedir());
  const available = (await modelRuntime.getAvailable()) as unknown as PiModel[];
  return available.filter((model) => {
    const fullId = `${model.provider}/${model.id}`;
    // enabledProviders deliberately not honored here: it is the
    // pi-suppress-providers extension's convention, and that extension (now
    // that extension loading works) applies it by suppressing auth env vars.
    if (settings.enabledModels?.length && !modelMatchesPatterns(fullId, settings.enabledModels)) {
      return false;
    }
    return true;
  });
}

/**
 * Catalog honoring pi's settings.json: enabledProviders and enabledModels
 * scope the list; defaultProvider/defaultModel, defaultThinkingLevel, and
 * modelThinkingLevels drive the reported defaults.
 */
export async function buildCatalog(
  modelRuntime: PiModelRuntimeLike,
  cwd?: string,
): Promise<ProviderCatalog> {
  const settings = readPiUserSettings(cwd ?? homedir());
  const scoped = await listScopedModels(modelRuntime, cwd);

  const defaultModelId =
    settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : undefined;
  const models = scoped.map((model): ProviderModel => {
    const fullId = `${model.provider}/${model.id}`;
    return {
      ...mapPiModel(
        model,
        settings.modelThinkingLevels?.[fullId] ?? settings.defaultThinkingLevel,
      ),
      ...(defaultModelId && fullId === defaultModelId ? { isDefault: true } : {}),
    };
  });
  const hasDefault = defaultModelId
    ? scoped.some((model) => `${model.provider}/${model.id}` === defaultModelId)
    : false;
  const defaultEntry = hasDefault
    ? models.find((model) => model.id === defaultModelId)
    : undefined;
  return {
    models,
    modes: [],
    ...(hasDefault && defaultModelId ? { defaultModel: defaultModelId } : {}),
    ...(defaultEntry?.defaultThinkingOptionId
      ? { defaultThinkingOption: defaultEntry.defaultThinkingOptionId }
      : {}),
  };
}

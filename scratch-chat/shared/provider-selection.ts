export interface ProviderModelSnapshot {
  id: string;
  isDefault?: boolean;
  isSelectable?: boolean;
}

export interface ProviderSnapshotEntry {
  provider: string;
  enabled?: boolean;
  models?: readonly ProviderModelSnapshot[];
}

export function selectProviderModel(
  entries: readonly ProviderSnapshotEntry[],
): string | null {
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const models = (entry.models ?? []).filter((model) => model.isSelectable !== false);
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    if (model) return `${entry.provider}/${model.id}`;
  }
  return null;
}

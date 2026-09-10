import type {
  PiPresetDefinition,
  PiPresetsSettings,
} from "../shared/preset-settings.js";
import type { PiPresetsConfig } from "./presets.js";

export interface PiPresetStoreSnapshot {
  presets: PiPresetsConfig;
  revision: string;
}

export interface PiPresetStore {
  snapshot(): PiPresetStoreSnapshot;
  update(values: PiPresetsSettings, revision: string, previousRevision: string | null): void;
  subscribe(listener: (snapshot: PiPresetStoreSnapshot) => void): () => void;
}

function toConfig(values: PiPresetsSettings): PiPresetsConfig {
  return Object.fromEntries(
    values.presets.map((preset: PiPresetDefinition) => [preset.id, preset]),
  );
}

export function createPiPresetStore(): PiPresetStore {
  let current: PiPresetStoreSnapshot = { presets: {}, revision: "missing" };
  const listeners = new Set<(snapshot: PiPresetStoreSnapshot) => void>();

  return {
    snapshot() {
      return current;
    },
    update(values, revision, previousRevision) {
      if (current.revision === revision) {
        return;
      }
      if (previousRevision !== null && previousRevision !== current.revision) {
        throw new Error("Pi preset settings changed before this sync completed");
      }
      current = { presets: toConfig(values), revision };
      for (const listener of listeners) listener(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

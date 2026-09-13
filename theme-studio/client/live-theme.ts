import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginThemeContribution } from "@getpaseo/plugin";

export interface LiveThemeController {
  attach(client: PluginClientContext): () => void;
  subscribe(listener: (theme: PluginThemeContribution) => void): () => void;
  update(theme: PluginThemeContribution): void;
  getCurrent(): PluginThemeContribution | null;
}

export function createLiveThemeController(): LiveThemeController {
  const listeners = new Set<(theme: PluginThemeContribution) => void>();
  let currentTheme: PluginThemeContribution | null = null;

  let register: ((theme: PluginThemeContribution) => () => void) | null = null;
  let removeTheme: (() => void) | null = null;

  return {
    attach(client) {
      register = (theme) => client.addTheme(theme);
      if (currentTheme) removeTheme = register(currentTheme);
      return () => {
        removeTheme?.();
        removeTheme = null;
        register = null;
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (currentTheme) listener(currentTheme);
      return () => {
        listeners.delete(listener);
      };
    },
    update(theme) {
      currentTheme = theme;
      removeTheme?.();
      removeTheme = register?.(theme) ?? null;
      for (const listener of listeners) {
        try {
          listener(theme);
        } catch (err) {
          console.warn("[theme-studio] Live theme listener error:", err);
        }
      }
    },
    getCurrent() {
      return currentTheme;
    },
  };
}

export const liveTheme = createLiveThemeController();

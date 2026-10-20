/**
 * Test-only stand-in for the host-provided Paseo SDK modules.
 *
 * Paseo externalizes `@getpaseo/*` from both bundles, so unit tests never need the real
 * implementations: contracts are plain objects and every UI export is an inert component.
 */

export interface RpcContract<Input = unknown, Output = unknown> {
  name: string;
  input: unknown;
  output: unknown;
  readonly __input?: Input;
  readonly __output?: Output;
}

export function defineRpc<Definition>(definition: Definition): Definition {
  return definition;
}

export function defineSettings<Definition>(definition: Definition): Definition {
  return definition;
}

export function settingsRpc(id: string): { id: string } {
  return { id };
}

export function defineAttachmentSource<Definition>(definition: Definition): Definition {
  return definition;
}

export function Icon(): null {
  return null;
}

export function Modal(): null {
  return null;
}

export function usePaseo(): Record<string, never> {
  return {};
}

export function useRpc(): () => Promise<unknown> {
  return async () => ({});
}

export function useSettings(): Record<string, never> {
  return {};
}

export function useToast(): { show(): void; error(): void } {
  return { show: () => {}, error: () => {} };
}

export function useRevealedText(text: string): string {
  return text;
}

export function copyText(): Promise<void> {
  return Promise.resolve();
}

export const FlatList = null;
export const ScrollView = null;
export const TextInput = null;
export const Pressable = null;

export const SettingsAction = null;
export const SettingsCard = null;
export const SettingsGroup = null;
export const SettingsInput = null;
export const SettingsRow = null;
export const SettingsSection = null;
export const SettingsSelect = null;
export const SettingsSwitch = null;
export const ExternalLink = null;

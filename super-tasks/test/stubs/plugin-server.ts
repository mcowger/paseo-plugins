export function defineRpc<Definition>(definition: Definition): Definition {
  return definition;
}

export function defineAttachmentSource<Definition>(definition: Definition): Definition {
  return definition;
}

export function Icon(): null {
  return null;
}

export function usePaseo(): unknown {
  return {};
}

export function useRpc(): () => Promise<unknown> {
  return async () => ({});
}

export const PROFILE_PRUNE_RETRY_DELAYS_MS = [0, 250, 1000] as const;

export async function saveProfilePolicyWithRetry(
  save: () => Promise<boolean>,
  reload: () => Promise<void>,
  retryDelays: readonly number[] = PROFILE_PRUNE_RETRY_DELAYS_MS,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<void> {
  let lastError: unknown = new Error("The profile policy cleanup was not saved");
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await wait(retryDelays[attempt - 1] ?? 0);
    try {
      if (await save()) return;
      lastError = new Error("The profile policy cleanup was not saved");
    } catch (error) {
      lastError = error;
    }
    if (attempt < retryDelays.length) await reload();
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

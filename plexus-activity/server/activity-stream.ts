import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { ActivitySubscribeInput, ActivityUpdate } from "../shared/view";
import type { ActivityService } from "./service";

/** Store changes arrive in bursts from one SSE frame each; one push per burst is enough for the panel. */
export const ACTIVITY_PUSH_DEBOUNCE_MS = 100;

/**
 * Serves one panel subscription. Sends a full snapshot immediately, then one delta per debounced burst
 * of service changes. The service listener is removed and any pending flush cancelled when the
 * subscriber's signal aborts, which happens on release, disconnect, or plugin stop.
 */
export function streamActivity(
  service: Pick<ActivityService, "snapshot" | "subscribe">,
  input: ActivitySubscribeInput,
  context: PluginSubscriptionContext<ActivityUpdate>,
): void {
  // An already-aborted signal never fires its abort listener, so subscribing would leak.
  if (context.signal.aborted) return;
  let cursor: number | null = null;
  let resetPending = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    const update = service.snapshot({ scope: input.scope, since: resetPending ? null : cursor });
    resetPending = false;
    cursor = update.cursor;
    // A failed push means the subscriber is gone; the abort listener below already cleaned up.
    context.push(update).catch(() => {});
  }

  function schedule(reset: boolean): void {
    resetPending = resetPending || reset;
    if (timer === null) timer = setTimeout(flush, ACTIVITY_PUSH_DEBOUNCE_MS);
  }

  const unsubscribe = service.subscribe(schedule);
  context.signal.addEventListener(
    "abort",
    () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    { once: true },
  );

  flush();
}

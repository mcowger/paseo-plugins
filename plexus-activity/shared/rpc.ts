import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import {
  activitySubscribeInputSchema,
  activityUpdateSchema,
  keysInputSchema,
  keysOutputSchema,
  snapshotInputSchema,
  verifyInputSchema,
  verifyOutputSchema,
} from "./view";

/**
 * The only way data reaches the panel. The panel reads one full or delta snapshot when it mounts
 * and as a recovery backstop, and receives every change through `activityStreamSubscription`.
 * Contracts never carry the admin key or a Plexus key secret.
 */
export const snapshotRpc = defineRpc({
  name: "plexus.activity.snapshot",
  input: snapshotInputSchema,
  output: activityUpdateSchema,
});

/** Server-to-client push: the handler sends a reset first, then debounced deltas until released. */
export const activityStreamSubscription = defineSubscription({
  name: "plexus.activity.stream",
  input: activitySubscribeInputSchema,
  event: activityUpdateSchema,
});

export const keysRpc = defineRpc({
  name: "plexus.activity.keys",
  input: keysInputSchema,
  output: keysOutputSchema,
});

/** Validates a candidate credential without persisting it. */
export const verifyRpc = defineRpc({
  name: "plexus.activity.verify",
  input: verifyInputSchema,
  output: verifyOutputSchema,
});

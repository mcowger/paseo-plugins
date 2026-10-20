import { defineRpc } from "@getpaseo/plugin";
import {
  keysInputSchema,
  keysOutputSchema,
  snapshotInputSchema,
  snapshotOutputSchema,
  verifyInputSchema,
  verifyOutputSchema,
} from "./view";

/**
 * The only way data reaches the panel: the 0.10.0 plugin protocol has no server-to-client push, so
 * the panel polls a delta snapshot. Contracts never carry the admin key or a Plexus key secret.
 */
export const snapshotRpc = defineRpc({
  name: "plexus.activity.snapshot",
  input: snapshotInputSchema,
  output: snapshotOutputSchema,
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

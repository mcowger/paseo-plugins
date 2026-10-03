import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Plugin UI contract for native Pi blocking dialogs.
 *
 * The public app question UI cannot seed a text field with an editor `prefill`
 * (see `server/dialogs.ts`), so the server exposes pending dialogs through these
 * RPCs and the plugin's own editor surface renders the prefill as a real initial
 * value. Host permission cards remain the primary path; this UI is a
 * supplementary path for fields the generic card cannot express.
 */

export const dialogMethodSchema = z.enum(["select", "confirm", "input", "editor"]);
export type DialogMethod = z.infer<typeof dialogMethodSchema>;

export const dialogViewSchema = z.object({
  permissionId: z.string().min(1),
  sessionId: z.string().min(1),
  method: dialogMethodSchema,
  title: z.string(),
  message: z.string().optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  prefill: z.string().optional(),
  confirmLabel: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  generation: z.string().optional(),
});
export type DialogView = z.infer<typeof dialogViewSchema>;

export const dialogAnswerSchema = z.discriminatedUnion("behavior", [
  z.object({
    behavior: z.literal("allow"),
    value: z.union([z.string(), z.boolean()]),
  }),
  z.object({
    behavior: z.literal("deny"),
    message: z.string().optional(),
  }),
]);
export type DialogAnswer = z.infer<typeof dialogAnswerSchema>;

export const listPendingDialogsRpc = defineRpc({
  name: "superpi.list-pending-dialogs",
  input: z.object({}),
  output: z.object({ dialogs: z.array(dialogViewSchema) }),
});

export const respondDialogRpc = defineRpc({
  name: "superpi.respond-dialog",
  input: z.object({
    sessionId: z.string().min(1),
    permissionId: z.string().min(1),
    generation: z.string().min(1),
    answer: dialogAnswerSchema,
  }),
  output: z.object({ resolved: z.boolean() }),
});

export type ListPendingDialogsOutput = z.infer<typeof listPendingDialogsRpc.output>;
export type RespondDialogInput = z.infer<typeof respondDialogRpc.input>;

/**
 * Initial editor text for a pending dialog. Only `editor` has a value to seed;
 * `input` uses its placeholder as a hint and starts empty.
 */
export function initialDialogDraft(view: DialogView): string {
  return view.method === "editor" ? (view.prefill ?? "") : "";
}

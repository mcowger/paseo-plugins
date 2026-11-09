import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Increment when the stub / chunk interface changes. Only function default exports survive Hermes interop. */
export const CLIENT_CHUNK_API = 1;
export interface ClientChunkManifest { name: string; hash: string; api: number; bytes: number }

export function createClientChunkRpc(name: string, names: readonly [string, ...string[]]) {
  const chunkName = z.enum(names);
  const hash = z.string().regex(/^[0-9a-f]{16}$/);
  return defineRpc({
    name,
    input: z.object({ name: chunkName, hash, part: z.number().int().min(0).max(4095) }).strict(),
    output: z.object({ name: chunkName, hash, api: z.number().int().positive(), part: z.number().int().nonnegative(), parts: z.number().int().positive().max(4096), code: z.string() }),
  });
}

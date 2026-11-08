import type { ClientChunkManifest } from "../shared/client-chunk";
import { addDefaults, t } from "../shared/i18n";
import { kitLazy } from "../shared/locales/kit/zh-CN.json";

addDefaults({ kitLazy });

// Leave 8 KiB for the host's RPC envelope. Count escaped JSON bytes, not source characters.
export const CLIENT_CHUNK_REPLY_BYTES = 120 * 1024;
interface ClientChunk extends ClientChunkManifest { code: string }
interface ChunkRequest { name: string; hash: string; part: number }

/** JSON string bytes, excluding the two surrounding quotes. Keep surrogate pairs in the same part. */
function splitChunk(chunk: ClientChunk): string[] {
  // 1 KiB covers fixed keys, content hash, version, part counts and the enum name.
  return splitReply(chunk.code, CLIENT_CHUNK_REPLY_BYTES - 1024 - Buffer.byteLength(JSON.stringify(chunk.name)));
}

/** Cuts `source` so each part, as a JSON string, stays within `budget` bytes. Also used for language catalogs. */
export function splitReply(source: string, budget: number): string[] {
  const slices: string[] = [];
  let start = 0, bytes = 0;
  for (let index = 0; index < source.length;) {
    const character = source.charCodeAt(index);
    let size: number, units = 1;
    if (character < 0x80) {
      size = character === 0x22 || character === 0x5c ? 2
        : character >= 0x20 ? 1
        : character === 8 || character === 9 || character === 10 || character === 12 || character === 13 ? 2 : 6;
    } else if (character < 0x800) size = 2;
    else if (character >= 0xd800 && character <= 0xdfff) {
      const next = source.charCodeAt(index + 1);
      if (character <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { size = 4; units = 2; }
      else size = 6; // JSON.stringify escapes a lone surrogate as \uXXXX.
    } else size = 3;
    if (bytes + size > budget) {
      slices.push(source.slice(start, index));
      if (slices.length >= 4096) throw new Error("Client chunk exceeds the part limit");
      start = index; bytes = 0;
    }
    bytes += size; index += units;
  }
  slices.push(source.slice(start));
  return slices;
}

export function createClientChunkHandler(chunks: readonly ClientChunk[]) {
  // Registration keeps only source references. Partition just the requested UI, once, on its first RPC.
  // Slices share the source string; appending every character would retain large V8 string ropes.
  const entries = new Map<string, { chunk: ClientChunk; slices?: string[] }>(chunks.map(chunk => [chunk.name, { chunk }]));
  return ({ name, hash, part }: ChunkRequest) => {
    const entry = entries.get(name);
    if (!entry || !Number.isInteger(part) || part < 0 || part >= 4096) throw new Error("Unknown client chunk or part");
    entry.slices ??= splitChunk(entry.chunk);
    if (part >= entry.slices.length) throw new Error("Unknown client chunk or part");
    // A stale stub can discover the current hash at part zero. Never splice two versions on reload.
    if (part > 0 && hash !== entry.chunk.hash) throw new Error(t("kitLazy.updated"));
    return { name, hash: entry.chunk.hash, api: entry.chunk.api, part, parts: entry.slices.length, code: entry.slices[part]! };
  };
}

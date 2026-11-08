import { createClientChunkRpc } from "./client-chunk";
export const getClientChunk = createClientChunkRpc("vivid.client-chunk.get", ["ui", "pi", "fx"]);

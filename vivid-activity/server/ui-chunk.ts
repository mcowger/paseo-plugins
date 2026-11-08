import { createClientChunkHandler } from "./client-chunks";
import { FX_CHUNK } from "../shared/generated/fx-chunk-manifest";
import { PI_CHUNK } from "../shared/generated/pi-chunk-manifest";
import { UI_CHUNK } from "../shared/generated/ui-chunk-manifest";
import fxCode from "./generated/fx-chunk.txt";
import piCode from "./generated/pi-chunk.txt";
import code from "./generated/ui-chunk.txt";

export const getUiChunk = createClientChunkHandler([{ ...UI_CHUNK, code }, { ...PI_CHUNK, code: piCode }, { ...FX_CHUNK, code: fxCode }]);

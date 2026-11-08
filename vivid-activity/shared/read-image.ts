import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Upper bound for an inlined read image. Keeps timeline payloads small. */
export const MAX_READ_IMAGE_BYTES = 3 * 1024 * 1024;

/** 0.4.1: the server reads this much of a file first and stops there unless it starts like a supported image. */
export const IMAGE_HEADER_BYTES = 32;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export const SUPPORTED_READ_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

export const readImageRpc = defineRpc({
  name: "read-image",
  input: z.object({
    filePath: z.string().min(1).max(4096),
    // 0.4.1: required. The Agent whose chat shows the read: its working directory bounds the preview.
    agentId: z.string().min(1).max(256),
  }),
  output: z.object({
    // 本地补丁：outside = 不在 Agent 工作目录或临时目录内，不读取。
    status: z.enum(["ok", "not-found", "not-image", "too-large", "unavailable", "outside"]),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    byteSize: z.number().int().nonnegative().optional(),
  }),
});

export type ReadImageResult = z.output<typeof readImageRpc.output>;

export function isImageFilePath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const name = filePath.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Extracts the mime type from Pi's `Read image file [<mime>]` placeholder text. */
export function parseReadImagePlaceholder(content: string | undefined): string | null {
  if (!content) return null;
  const match = content.match(/^\s*Read image file \[([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)\]/);
  return match?.[1] ?? null;
}

/** True when a read detail looks like an image the model consumed as vision input. */
export function shouldAttemptImageLoad(
  filePath: string | undefined,
  content: string | undefined,
): boolean {
  return isImageFilePath(filePath) || parseReadImagePlaceholder(content) !== null;
}

/** BMP DIB header sizes: OS/2 1.x core (12), OS/2 2.x (16, 64), BITMAPINFOHEADER (40) and its V2 to V5 (52, 56, 108, 124). */
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

/**
 * 0.4.1: a BMP is more than its `BM`: the file size field must match the file, the DIB header size must be a known one,
 * and the pixel data must start after both headers and inside the file. `fileLength` is the whole file's length when
 * `bytes` is only its first bytes.
 */
function isBmp(bytes: Uint8Array, fileLength: number): boolean {
  if (bytes.length < 18 || fileLength < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredSize = view.getUint32(2, true);
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  return BMP_DIB_HEADER_SIZES.has(dibSize) && declaredSize === fileLength && pixelOffset >= 14 + dibSize && pixelOffset <= fileLength;
}

/**
 * Detects a supported image mime type from magic bytes. Returns null when unknown. `fileLength` is the length of the
 * whole file when `bytes` holds only its first bytes (at least IMAGE_HEADER_BYTES of them).
 */
export function detectImageMimeType(bytes: Uint8Array, fileLength: number = bytes.length): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (isBmp(bytes, fileLength)) {
    return "image/bmp";
  }
  return null;
}

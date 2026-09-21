import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PiImageContent, PiModel } from "./rpc-types.js";

// DIVERGENCE(pi-image-budgets): pi-scale 2 MiB per image / 8 MiB aggregate per
// turn, not the OMP reference 16 MiB aggregate. Recorded per NG item 2.
export const MAX_PI_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PI_TURN_IMAGE_BYTES = 8 * 1024 * 1024;

export type PiImageMimeType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

const PI_IMAGE_MIME_TYPES: Readonly<Record<string, true>> = {
  "image/gif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
};

export function isPiImageMimeType(value: string): value is PiImageMimeType {
  return PI_IMAGE_MIME_TYPES[value] === true;
}

export class PiImageValidationError extends Error {
  override name = "PiImageValidationError";
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

function decodedByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length / 4) * 3) - padding;
}

interface PiValidatedImagePayload {
  bytes: Buffer;
  mimeType: PiImageMimeType;
}

export function validatePiImagePayload(data: string, mimeType: string): Buffer {
  return validatePiImage(data, mimeType).bytes;
}

function validatePiImage(data: string, mimeType: string): PiValidatedImagePayload {
  if (!isPiImageMimeType(mimeType)) {
    throw new PiImageValidationError(`Unsupported image MIME type '${mimeType}'`);
  }
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    throw new PiImageValidationError("Image data is not valid base64");
  }
  // The strict base64 shape above makes this exact, so the budget applies
  // before anything is materialized in the heap: a multi-hundred-MB
  // attacker string is rejected without decoding it. (`Buffer.from` never
  // throws on base64 input, so there is no try/catch here by design.)
  if (decodedByteLength(data) > MAX_PI_IMAGE_BYTES) {
    throw new PiImageValidationError(
      `Image exceeds per-image budget of ${MAX_PI_IMAGE_BYTES} bytes`,
    );
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0) {
    throw new PiImageValidationError("Image data is empty");
  }
  if (!matchesMagicBytes(bytes, mimeType)) {
    throw new PiImageValidationError(`Image payload does not match MIME type '${mimeType}'`);
  }
  return { bytes, mimeType };
}

function matchesMagicBytes(bytes: Buffer, mimeType: PiImageMimeType): boolean {
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    return (
      bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
        bytes.subarray(0, 6).toString("ascii") === "GIF89a")
    );
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

function imageExtension(mimeType: PiImageMimeType): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType.slice("image/".length);
}

const ATTACHMENT_DIRECTORY_PREFIX = "paseo-pi-images-";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class PiImageMaterializer {
  private directory: string | null = null;
  private readonly files = new Map<string, { path: string; bytes: number; references: number }>();
  private readonly paths = new Map<string, string>();
  private retainedBytes = 0;

  constructor(private readonly maxBytes = MAX_PI_TURN_IMAGE_BYTES) {}

  materialize(data: string, mimeType: string): string {
    const { bytes, mimeType: validatedMime } = validatePiImage(data, mimeType);
    // Validate (and recreate if needed) the directory before the dedup hit
    // and the budget check: after external tmp cleanup the cache may hold
    // paths that no longer exist and `retainedBytes` may describe deleted
    // files. Directory state is the source of truth, not memory.
    if (!this.ensureDirectoryUsable()) {
      this.directory = mkdtempSync(join(tmpdir(), ATTACHMENT_DIRECTORY_PREFIX));
      chmodSync(this.directory, PRIVATE_DIRECTORY_MODE);
      // Previously handed-out paths pointed into the deleted directory and
      // are unrecoverable (callers already embedded them in hint text), so
      // the bookkeeping resets rather than pretending they still exist.
      this.files.clear();
      this.paths.clear();
      this.retainedBytes = 0;
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.files.get(hash);
    if (existing) {
      existing.references += 1;
      return existing.path;
    }
    if (this.retainedBytes + bytes.byteLength > this.maxBytes) {
      throw new PiImageValidationError(
        `Image aggregate budget of ${this.maxBytes} bytes exceeded`,
      );
    }
    const path = join(this.directory!, `${hash}.${imageExtension(validatedMime)}`);
    try {
      writeFileSync(path, bytes, { mode: PRIVATE_FILE_MODE });
      chmodSync(path, PRIVATE_FILE_MODE);
    } catch (error) {
      rmSync(path, { force: true });
      // eslint-disable-next-line no-console
      console.warn(`[pi-plugin-mcowger] image write failed: ${String(error)}`);
      throw error;
    }
    this.files.set(hash, { path, bytes: bytes.byteLength, references: 1 });
    this.paths.set(path, hash);
    this.retainedBytes += bytes.byteLength;
    return path;
  }

  release(paths: readonly string[]): void {
    for (const path of paths) {
      const hash = this.paths.get(path);
      if (hash === undefined) continue;
      const file = this.files.get(hash);
      if (!file) {
        this.paths.delete(path);
        continue;
      }
      file.references -= 1;
      if (file.references > 0) continue;
      rmSync(file.path, { force: true });
      this.files.delete(hash);
      this.paths.delete(path);
      this.retainedBytes -= file.bytes;
    }
    if (this.files.size === 0 && this.directory) {
      rmSync(this.directory, { force: true, recursive: true });
      this.directory = null;
    }
  }

  clear(): void {
    if (this.directory) rmSync(this.directory, { force: true, recursive: true });
    this.directory = null;
    this.files.clear();
    this.paths.clear();
    this.retainedBytes = 0;
  }

  // Directory check with no hidden side effects: re-hardening the mode is
  // the caller's job after a `true` result. Returns whether `directory`
  // is a usable directory right now.
  private isDirectoryUsable(): boolean {
    if (!this.directory) return false;
    try {
      return lstatSync(this.directory).isDirectory();
    } catch {
      return false;
    }
  }

  // Ensures `directory` exists as a private directory. Returns true when
  // the caller may use it, false when it must recreate it (see
  // `materialize`).
  private ensureDirectoryUsable(): boolean {
    if (!this.directory || !this.isDirectoryUsable()) return false;
    chmodSync(this.directory, PRIVATE_DIRECTORY_MODE);
    return true;
  }
}

export function piModelSupportsImageInput(model: PiModel | null | undefined): boolean {
  return model?.input?.includes("image") === true;
}

export interface PiConvertedPrompt {
  text: string;
  images: PiImageContent[];
  materializedPaths: string[];
}

export interface PiPromptImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

// Contract (intentional asymmetry): on the capable path an aggregate
// overflow throws `PiImageValidationError` before any RPC so the caller
// fails the turn visibly; on the text-only fallback path the same overflow
// degrades to an `[Image attachment omitted: ...]` hint because the prompt
// itself is still sendable without that image. Callers must handle both.
export function convertPromptImages(
  textParts: string[],
  imageBlocks: readonly PiPromptImageBlock[],
  options: { model: PiModel | null | undefined; materializer: PiImageMaterializer },
): PiConvertedPrompt {
  const materializedPaths: string[] = [];
  if (piModelSupportsImageInput(options.model)) {
    let aggregate = 0;
    const images: PiImageContent[] = [];
    for (const block of imageBlocks) {
      const bytes = validatePiImagePayload(block.data, block.mimeType);
      aggregate += bytes.byteLength;
      if (aggregate > MAX_PI_TURN_IMAGE_BYTES) {
        throw new PiImageValidationError(
          `Image aggregate budget of ${MAX_PI_TURN_IMAGE_BYTES} bytes exceeded`,
        );
      }
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
    return { text: textParts.join("\n\n"), images, materializedPaths };
  }
  const hints = [...textParts];
  for (const block of imageBlocks) {
    try {
      const path = options.materializer.materialize(block.data, block.mimeType);
      materializedPaths.push(path);
      hints.push(`[Image available at: ${path}]`);
    } catch (error) {
      hints.push(
        `[Image attachment omitted: ${error instanceof PiImageValidationError ? error.message : "failed to write local file"}]`,
      );
    }
  }
  return { text: hints.join("\n\n"), images: [], materializedPaths };
}

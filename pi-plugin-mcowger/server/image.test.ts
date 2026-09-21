import { existsSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, test } from "vitest";

import {
  MAX_PI_IMAGE_BYTES,
  MAX_PI_TURN_IMAGE_BYTES,
  PiImageMaterializer,
  PiImageValidationError,
  convertPromptImages,
  isPiImageMimeType,
  piModelSupportsImageInput,
  validatePiImagePayload,
} from "./image.js";

// 1x1 PNG (68 bytes decoded).
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1X1 = "R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=";

function jpegBytes(): string {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  return bytes.toString("base64");
}

function webpBytes(): string {
  const bytes = Buffer.alloc(12);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  return bytes.toString("base64");
}

describe("validatePiImagePayload", () => {
  test("accepts PNG, JPEG, GIF, WebP magic bytes", () => {
    expect(validatePiImagePayload(PNG_1X1, "image/png").byteLength).toBeGreaterThan(0);
    expect(validatePiImagePayload(GIF_1X1, "image/gif").byteLength).toBeGreaterThan(0);
    expect(validatePiImagePayload(jpegBytes(), "image/jpeg").byteLength).toBeGreaterThan(0);
    expect(validatePiImagePayload(webpBytes(), "image/webp").byteLength).toBeGreaterThan(0);
  });

  test("rejects a huge base64 payload by arithmetic before decoding", () => {
    // 12 MiB of strict base64 decodes to 9 MiB; the per-image budget must
    // reject it without materializing the decoded bytes.
    const huge = `${"QUJD".repeat((12 * 1024 * 1024) / 4)}`;
    expect(() => validatePiImagePayload(huge, "image/png")).toThrow(/per-image budget/);
  });

  test("rejects mismatched magic bytes", () => {
    expect(() => validatePiImagePayload(PNG_1X1, "image/jpeg")).toThrow(PiImageValidationError);
    expect(() => validatePiImagePayload(GIF_1X1, "image/png")).toThrow(PiImageValidationError);
  });

  test("rejects unsupported MIME types", () => {
    expect(isPiImageMimeType("image/svg+xml")).toBe(false);
    expect(() => validatePiImagePayload(PNG_1X1, "image/svg+xml")).toThrow(PiImageValidationError);
  });

  test("rejects malformed base64", () => {
    expect(() => validatePiImagePayload("!!!", "image/png")).toThrow(PiImageValidationError);
    expect(() => validatePiImagePayload("abc", "image/png")).toThrow(PiImageValidationError);
    expect(() => validatePiImagePayload("", "image/png")).toThrow(PiImageValidationError);
  });

  test("rejects per-image budget overflow", () => {
    const big = Buffer.alloc(MAX_PI_IMAGE_BYTES + 16);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    expect(() => validatePiImagePayload(big.toString("base64"), "image/jpeg")).toThrow(
      /per-image budget/,
    );
  });
});

describe("PiImageMaterializer", () => {
  test("dedups identical content to the same path", () => {
    const materializer = new PiImageMaterializer();
    try {
      const first = materializer.materialize(PNG_1X1, "image/png");
      const second = materializer.materialize(PNG_1X1, "image/png");
      expect(second).toBe(first);
      materializer.release([first]);
      expect(existsSync(first)).toBe(true);
      materializer.release([second]);
      expect(existsSync(first)).toBe(false);
    } finally {
      materializer.clear();
    }
  });

  test("uses private directory and file modes", () => {
    const materializer = new PiImageMaterializer();
    try {
      const path = materializer.materialize(PNG_1X1, "image/png");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      materializer.clear();
    }
  });

  test("enforces aggregate turn budget", () => {
    const materializer = new PiImageMaterializer(10);
    try {
      expect(() => materializer.materialize(PNG_1X1, "image/png")).toThrow(/aggregate budget/);
      expect(MAX_PI_TURN_IMAGE_BYTES).toBe(8 * 1024 * 1024);
    } finally {
      materializer.clear();
    }
  });

  test("recreates an externally removed directory instead of spurious budget rejects", () => {
    const materializer = new PiImageMaterializer(100);
    const first = materializer.materialize(PNG_1X1, "image/png");
    try {
      // External tmp cleanup: memory still accounts 68 bytes, but the
      // directory state wins and the budget resets with the new directory.
      rmSync(dirname(first), { force: true, recursive: true });
      const second = materializer.materialize(PNG_1X1, "image/png");
      expect(existsSync(second)).toBe(true);
    } finally {
      materializer.clear();
    }
  });

  test("dedup never hands back a path from a removed directory", () => {
    const materializer = new PiImageMaterializer();
    const first = materializer.materialize(PNG_1X1, "image/png");
    try {
      rmSync(dirname(first), { force: true, recursive: true });
      const second = materializer.materialize(PNG_1X1, "image/png");
      expect(existsSync(second)).toBe(true);
    } finally {
      materializer.clear();
    }
  });

  test("clear removes temp files", () => {
    const materializer = new PiImageMaterializer();
    const path = materializer.materialize(PNG_1X1, "image/png");
    expect(existsSync(path)).toBe(true);
    materializer.clear();
    expect(existsSync(path)).toBe(false);
  });
});

describe("convertPromptImages", () => {
  test("capable models get native image blocks and create no files", () => {
    const materializer = new PiImageMaterializer();
    try {
      const converted = convertPromptImages(["hello"], [{ type: "image", data: PNG_1X1, mimeType: "image/png" }], {
        model: { provider: "openai", id: "gpt", input: ["text", "image"] },
        materializer,
      });
      expect(converted.text).toBe("hello");
      expect(converted.images).toHaveLength(1);
      expect(converted.materializedPaths).toEqual([]);
    } finally {
      materializer.clear();
    }
  });

  test("text-only models get file hint text", () => {
    const materializer = new PiImageMaterializer();
    try {
      const converted = convertPromptImages(["hello"], [{ type: "image", data: PNG_1X1, mimeType: "image/png" }], {
        model: { provider: "anthropic", id: "claude", input: ["text"] },
        materializer,
      });
      expect(converted.images).toEqual([]);
      expect(converted.materializedPaths).toHaveLength(1);
      expect(converted.text).toContain("[Image available at: ");
      expect(existsSync(converted.materializedPaths[0]!)).toBe(true);
    } finally {
      materializer.clear();
    }
  });

  test("text-only invalid payload renders omitted hint", () => {
    const materializer = new PiImageMaterializer();
    try {
      const converted = convertPromptImages(["hello"], [{ type: "image", data: "!!!", mimeType: "image/png" }], {
        model: null,
        materializer,
      });
      expect(converted.images).toEqual([]);
      expect(converted.materializedPaths).toEqual([]);
      expect(converted.text).toContain("[Image attachment omitted:");
    } finally {
      materializer.clear();
    }
  });

  test("capable invalid payload throws before RPC", () => {
    const materializer = new PiImageMaterializer();
    try {
      expect(() =>
        convertPromptImages(["hi"], [{ type: "image", data: "!!!", mimeType: "image/png" }], {
          model: { provider: "openai", id: "gpt", input: ["image"] },
          materializer,
        }),
      ).toThrow(PiImageValidationError);
    } finally {
      materializer.clear();
    }
  });

  test("piModelSupportsImageInput gates on input capability", () => {
    expect(piModelSupportsImageInput(null)).toBe(false);
    expect(piModelSupportsImageInput(undefined)).toBe(false);
    expect(piModelSupportsImageInput({ provider: "p", id: "m", input: ["text"] })).toBe(false);
    expect(piModelSupportsImageInput({ provider: "p", id: "m", input: ["text", "image"] })).toBe(true);
  });
});

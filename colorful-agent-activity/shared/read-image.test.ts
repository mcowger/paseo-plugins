import { describe, expect, it } from "vitest";
import {
  detectImageMimeType,
  isImageFilePath,
  parseReadImagePlaceholder,
  shouldAttemptImageLoad,
} from "./read-image";

describe("isImageFilePath", () => {
  it("matches supported image extensions case-insensitively", () => {
    expect(isImageFilePath("/tmp/shot.PNG")).toBe(true);
    expect(isImageFilePath("C:\\shots\\19_editor_dirty.png")).toBe(true);
    expect(isImageFilePath("photo.jpg")).toBe(true);
    expect(isImageFilePath("photo.jpeg")).toBe(true);
    expect(isImageFilePath("anim.gif")).toBe(true);
    expect(isImageFilePath("shot.webp")).toBe(true);
    expect(isImageFilePath("bitmap.bmp")).toBe(true);
  });

  it("rejects non-image and extensionless paths", () => {
    expect(isImageFilePath("/tmp/notes.md")).toBe(false);
    expect(isImageFilePath("/tmp/no-extension")).toBe(false);
    expect(isImageFilePath("/tmp/vector.svg")).toBe(false);
    expect(isImageFilePath(undefined)).toBe(false);
    expect(isImageFilePath("")).toBe(false);
  });
});

describe("parseReadImagePlaceholder", () => {
  it("extracts the mime type from Pi placeholder text", () => {
    expect(parseReadImagePlaceholder("Read image file [image/png]")).toBe("image/png");
    expect(parseReadImagePlaceholder("Read image file [image/jpeg]\n800x600")).toBe("image/jpeg");
  });

  it("returns null for ordinary text", () => {
    expect(parseReadImagePlaceholder("const x = 1;")).toBeNull();
    expect(parseReadImagePlaceholder(undefined)).toBeNull();
    expect(parseReadImagePlaceholder("")).toBeNull();
  });
});

describe("shouldAttemptImageLoad", () => {
  it("loads when either the path or the placeholder signals an image", () => {
    expect(shouldAttemptImageLoad("/tmp/a.png", undefined)).toBe(true);
    expect(shouldAttemptImageLoad("/tmp/a.bin", "Read image file [image/png]")).toBe(true);
    expect(shouldAttemptImageLoad("/tmp/a.png", "Read image file [image/png]")).toBe(true);
  });

  it("skips ordinary text reads", () => {
    expect(shouldAttemptImageLoad("/tmp/a.ts", "const x = 1;")).toBe(false);
    expect(shouldAttemptImageLoad(undefined, undefined)).toBe(false);
  });
});

describe("detectImageMimeType", () => {
  it("detects magic bytes for supported formats", () => {
    expect(
      detectImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
    expect(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      detectImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])),
    ).toBe("image/gif");
    expect(
      detectImageMimeType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
    expect(detectImageMimeType(new Uint8Array([0x42, 0x4d]))).toBe("image/bmp");
  });

  it("returns null for text and truncated input", () => {
    expect(detectImageMimeType(new TextEncoder().encode("const x = 1;"))).toBeNull();
    expect(detectImageMimeType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectImageMimeType(new Uint8Array([]))).toBeNull();
  });
});

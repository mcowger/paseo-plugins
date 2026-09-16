import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { MAX_READ_IMAGE_BYTES } from "../shared/read-image.js";
import { handleReadImage, resolveAbsolutePath } from "./read-image.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function contextWithCwd(cwd: string | null): PluginHandlerContext {
  return {
    paseo: {
      agents: {
        ref: () => ({
          refresh: async () => undefined,
          cwd,
        }),
      },
    },
  } as unknown as PluginHandlerContext;
}

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "read-image-test-"));
  return (async () => {
    await run(dir);
  })().finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("resolveAbsolutePath", () => {
  it("keeps absolute paths and resolves relative paths against the agent cwd", () => {
    expect(resolveAbsolutePath("/tmp/a.png", null)).toBe("/tmp/a.png");
    expect(resolveAbsolutePath("shot.png", "/work/dir")).toBe(join("/work/dir", "shot.png"));
  });

  it("returns null for blank paths and relative paths without a cwd", () => {
    expect(resolveAbsolutePath("   ", "/work")).toBeNull();
    expect(resolveAbsolutePath("shot.png", null)).toBeNull();
  });
});

describe("handleReadImage", () => {
  it("returns base64 for an image file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "shot.png");
      writeFileSync(file, PNG_BYTES);
      const result = await handleReadImage({ filePath: file }, contextWithCwd(null));
      expect(result.status).toBe("ok");
      expect(result.mimeType).toBe("image/png");
      expect(result.byteSize).toBe(PNG_BYTES.length);
      expect(Buffer.from(result.data ?? "", "base64").equals(PNG_BYTES)).toBe(true);
    });
  });

  it("resolves relative paths against the agent cwd", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "shot.png"), PNG_BYTES);
      const result = await handleReadImage(
        { filePath: "shot.png", agentId: "agent-1" },
        contextWithCwd(dir),
      );
      expect(result.status).toBe("ok");
    });
  });

  it("reports not-found for missing files and directories", async () => {
    await withTempDir(async (dir) => {
      const missing = await handleReadImage(
        { filePath: join(dir, "missing.png") },
        contextWithCwd(null),
      );
      expect(missing.status).toBe("not-found");
      const directory = await handleReadImage({ filePath: dir }, contextWithCwd(null));
      expect(directory.status).toBe("not-found");
    });
  });

  it("reports not-image for text files", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "notes.md");
      writeFileSync(file, "# hello\n");
      const result = await handleReadImage({ filePath: file }, contextWithCwd(null));
      expect(result.status).toBe("not-image");
    });
  });

  it("reports too-large without reading the file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "huge.png");
      writeFileSync(file, Buffer.alloc(MAX_READ_IMAGE_BYTES + 1, 0));
      const result = await handleReadImage({ filePath: file }, contextWithCwd(null));
      expect(result.status).toBe("too-large");
      expect(result.byteSize).toBe(MAX_READ_IMAGE_BYTES + 1);
      expect(result.data).toBeUndefined();
    });
  });

  it("reports unavailable for relative paths without an agent cwd", async () => {
    const result = await handleReadImage({ filePath: "shot.png" }, contextWithCwd(null));
    expect(result.status).toBe("unavailable");
  });
});

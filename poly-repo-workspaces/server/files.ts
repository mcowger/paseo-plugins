import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FsPort } from "./ports";

function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createFsPort(): FsPort {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async writeFileAtomic(path: string, content: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tmpPath, content, "utf8");
        await rename(tmpPath, path);
      } catch (error) {
        await rm(tmpPath, { force: true });
        throw error;
      }
    },
    async mkdirp(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
    },
    async readdir(path: string): Promise<string[] | null> {
      try {
        return await readdir(path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async exists(path: string): Promise<boolean> {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isDirectory();
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async removeRecursive(path: string): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { IMAGE_HEADER_BYTES, MAX_READ_IMAGE_BYTES } from "../shared/read-image.js";
import {
  defaultTempRoots,
  handleReadImage,
  imageRoots,
  isInside,
  previewAgentId,
  readUpTo,
  resolveAbsolutePath,
  type ImageFile,
  type ReadImageIo,
} from "./read-image.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** A daemon whose Agents all work in `cwd` (null: it knows no Agent). `asked` collects the ids it was asked about. */
function contextWithCwd(cwd: string | null, asked: string[] = []): PluginHandlerContext {
  return {
    paseo: {
      agents: {
        ref: (id: string) => {
          asked.push(id);
          return { refresh: async () => undefined, cwd };
        },
      },
    },
  } as unknown as PluginHandlerContext;
}

/**
 * A sandbox with an agent workspace, a stand-in temp directory and an "elsewhere" directory that is
 * neither. The real system temp is not passed as a root, so the containment rules are what decide.
 */
function withSandbox(run: (dirs: { root: string; cwd: string; temp: string; elsewhere: string }) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "read-image-test-"));
  const dirs = { root, cwd: join(root, "workspace"), temp: join(root, "temp"), elsewhere: join(root, "elsewhere") };
  for (const dir of [dirs.cwd, dirs.temp, dirs.elsewhere]) mkdirSync(dir);
  return (async () => {
    await run(dirs);
  })().finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

/** `agentId` null: the request names no Agent at all. */
const read = (filePath: string, cwd: string | null, temp: string[], agentId: string | null = "agent-1", io?: ReadImageIo) =>
  handleReadImage({ filePath, ...(agentId !== null ? { agentId } : {}) } as { filePath: string; agentId: string }, contextWithCwd(cwd), temp, io);

/**
 * File access that counts the bytes read and refuses whole-file reads. `grow` appends that many bytes to the file right
 * after the open handle's first stat (a file still being written), `swap` opens another file than the one asked for (a
 * parent directory replaced by a link between the checks and the open), `noProc` hides /proc/self/fd so the dev/ino
 * fallback decides.
 */
function trackedIo(options: { grow?: number; swap?: string; noProc?: boolean } = {}) {
  let bytesRead = 0;
  const io: ReadImageIo = {
    async open(path, flags) {
      const target = options.swap ?? path;
      const real = await openFile(target, flags);
      let grown = false;
      const file = {
        fd: real.fd,
        async stat() {
          const stats = await real.stat();
          if (options.grow && !grown) {
            grown = true;
            appendFileSync(target, Buffer.alloc(options.grow, 1));
          }
          return stats;
        },
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          const result = await real.read(buffer, offset, length, position);
          bytesRead += result.bytesRead;
          return result;
        },
        readFile() {
          throw new Error("whole-file reads are not allowed");
        },
        close: () => real.close(),
      };
      return file as unknown as ImageFile;
    },
    fdPath: options.noProc
      ? async () => null
      : async (fd) => {
          const { readlink } = await import("node:fs/promises");
          return readlink(`/proc/self/fd/${fd}`).catch(() => null);
        },
  };
  return { io, bytesRead: () => bytesRead };
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

describe("isInside", () => {
  it("accepts the root and anything below it", () => {
    expect(isInside("/work", "/work")).toBe(true);
    expect(isInside("/work", "/work/a/b.png")).toBe(true);
    expect(isInside("/work", "/work/..png")).toBe(true);
  });

  it("rejects siblings, parents and dot-dot escapes", () => {
    expect(isInside("/work", "/work2/a.png")).toBe(false);
    expect(isInside("/work", "/")).toBe(false);
    expect(isInside("/work", "/work/../etc/passwd")).toBe(false);
    expect(isInside("/work/a", "/work/b/c.png")).toBe(false);
  });
});

describe("imageRoots", () => {
  it("uses the agent cwd and temp roots, resolving links, and skips missing or relative roots", async () => {
    await withSandbox(async ({ root, cwd, temp }) => {
      const link = join(root, "cwd-link");
      symlinkSync(cwd, link);
      const roots = await imageRoots(link, [temp, join(root, "missing"), "relative/dir"]);
      expect(roots.lexical).toEqual([link, temp, join(root, "missing")]);
      expect(roots.real).toEqual([cwd, temp].map((dir) => execFileSync("realpath", [dir]).toString().trim()));
    });
  });
});

describe("defaultTempRoots", () => {
  it("is os.tmpdir() alone; macOS adds /tmp, where agents and browser tools put screenshots (0.4.1)", () => {
    expect(defaultTempRoots("linux", "/tmp", "/home/user")).toEqual(["/tmp"]);
    expect(defaultTempRoots("linux", "/var/tmp/user-1000", "/home/user")).toEqual(["/var/tmp/user-1000"]);
    expect(defaultTempRoots("darwin", "/var/folders/ab/cd/T", "/Users/user")).toEqual(["/var/folders/ab/cd/T", "/tmp"]);
    expect(defaultTempRoots("darwin", "/tmp/", "/Users/user")).toEqual(["/tmp"]);
  });

  it("ignores a TMPDIR that is / or holds the home directory, which would open that whole tree (0.4.1)", () => {
    expect(defaultTempRoots("linux", "/", "/home/user")).toEqual([]);
    expect(defaultTempRoots("linux", "/home", "/home/user")).toEqual([]);
    expect(defaultTempRoots("linux", "/home/user", "/home/user")).toEqual([]);
    expect(defaultTempRoots("darwin", "/Users/user", "/Users/user")).toEqual(["/tmp"]);
    expect(defaultTempRoots("linux", "/home/user/.cache/tmp", "/home/user")).toEqual(["/home/user/.cache/tmp"]);
    expect(defaultTempRoots("linux", "relative/tmp", "/home/user")).toEqual([]);
  });
});

describe("previewAgentId", () => {
  it("reads a provider subagent's pane id as its parent Agent; other ids stay as they are (0.4.1)", () => {
    const parent = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
    expect(previewAgentId(parent)).toBe(parent);
    expect(previewAgentId(`provider:${parent}:toolu_01ExampleSubagentCall`)).toBe(parent);
    expect(previewAgentId(`provider:${encodeURIComponent("a:b")}:${encodeURIComponent("x:y")}`)).toBe("a:b");
    expect(previewAgentId("provider:%E0%A4%A:toolu_01")).toBe("provider:%E0%A4%A:toolu_01");
    expect(previewAgentId("provider:only-one-part")).toBe("provider:only-one-part");
  });
});

describe("readUpTo", () => {
  it("reads from the start, at most the given number of bytes (0.4.1)", async () => {
    await withSandbox(async ({ cwd }) => {
      const file = join(cwd, "data.bin");
      writeFileSync(file, Buffer.alloc(200_000, 7));
      const handle = await openFile(file, "r");
      try {
        expect((await readUpTo(handle, 10)).byteLength).toBe(10);
        const all = await readUpTo(handle, 1_000_000);
        expect(all.byteLength).toBe(200_000);
        expect(all.every((byte) => byte === 7)).toBe(true);
        expect((await readUpTo(handle, 0)).byteLength).toBe(0);
      } finally {
        await handle.close();
      }
    });
  });
});

describe("handleReadImage", () => {
  it("returns base64 for an image in the agent cwd", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const file = join(cwd, "shot.png");
      writeFileSync(file, PNG_BYTES);
      const result = await read(file, cwd, [temp]);
      expect(result.status).toBe("ok");
      expect(result.mimeType).toBe("image/png");
      expect(result.byteSize).toBe(PNG_BYTES.length);
      expect(Buffer.from(result.data ?? "", "base64").equals(PNG_BYTES)).toBe(true);
    });
  });

  it("resolves relative paths against the agent cwd", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      mkdirSync(join(cwd, "shots"));
      writeFileSync(join(cwd, "shots", "shot.png"), PNG_BYTES);
      expect((await read("shots/shot.png", cwd, [temp])).status).toBe("ok");
    });
  });

  it("reads screenshots from the temp directory", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const file = join(temp, "screenshot.png");
      writeFileSync(file, PNG_BYTES);
      expect((await read(file, cwd, [temp])).status).toBe("ok");
    });
  });

  it("requires an Agent the daemon knows: without one nothing is read, not even the temp directory (0.4.1)", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      writeFileSync(join(cwd, "shot.png"), PNG_BYTES);
      writeFileSync(join(temp, "shot.png"), PNG_BYTES);
      for (const file of [join(temp, "shot.png"), join(cwd, "shot.png"), "shot.png"]) {
        expect(await read(file, cwd, [temp], null)).toEqual({ status: "unavailable" });
        expect(await read(file, cwd, [temp], "   ")).toEqual({ status: "unavailable" });
        // An id the daemon does not know (no cwd), or a lookup that fails.
        expect(await read(file, null, [temp], "no-such-agent")).toEqual({ status: "unavailable" });
        const failing = { paseo: { agents: { ref: () => ({ refresh: async () => { throw new Error("Agent not found"); }, cwd: null }) } } } as unknown as PluginHandlerContext;
        expect(await handleReadImage({ filePath: file, agentId: "no-such-agent" }, failing, [temp])).toEqual({ status: "unavailable" });
      }
    });
  });

  it("previews in a provider subagent's own pane with its parent Agent's working directory (0.4.1)", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      writeFileSync(join(cwd, "shot.png"), PNG_BYTES);
      writeFileSync(join(temp, "shot.png"), PNG_BYTES);
      const asked: string[] = [];
      const pane = "provider:6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5:toolu_01ExampleSubagentCall";
      const call = (filePath: string) => handleReadImage({ filePath, agentId: pane }, contextWithCwd(cwd, asked), [temp]);
      expect((await call("shot.png")).status).toBe("ok");
      expect((await call(join(temp, "shot.png"))).status).toBe("ok");
      expect(asked).toEqual(["6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5", "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5"]);
    });
  });

  it("refuses images outside the agent cwd and temp directories without revealing whether they exist", async () => {
    await withSandbox(async ({ cwd, temp, elsewhere }) => {
      const file = join(elsewhere, "secret.png");
      writeFileSync(file, PNG_BYTES);
      const existing = await read(file, cwd, [temp]);
      const missing = await read(join(elsewhere, "missing.png"), cwd, [temp]);
      expect(existing).toEqual({ status: "outside" });
      expect(missing).toEqual({ status: "outside" });
    });
  });

  it("refuses dot-dot escapes from the cwd", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      writeFileSync(join(cwd, "..", "elsewhere", "secret.png"), PNG_BYTES);
      expect((await read("../elsewhere/secret.png", cwd, [temp])).status).toBe("outside");
      expect((await read(join(cwd, "..", "elsewhere", "secret.png"), cwd, [temp])).status).toBe("outside");
    });
  });

  it("follows links by their real target: a link out of the cwd is refused, a link into it is allowed", async () => {
    await withSandbox(async ({ cwd, temp, elsewhere }) => {
      writeFileSync(join(elsewhere, "secret.png"), PNG_BYTES);
      symlinkSync(join(elsewhere, "secret.png"), join(cwd, "innocent.png"));
      symlinkSync(elsewhere, join(cwd, "linked-dir"));
      expect((await read(join(cwd, "innocent.png"), cwd, [temp])).status).toBe("outside");
      expect((await read("linked-dir/secret.png", cwd, [temp])).status).toBe("outside");
      writeFileSync(join(cwd, "real.png"), PNG_BYTES);
      symlinkSync(join(cwd, "real.png"), join(cwd, "alias.png"));
      expect((await read("alias.png", cwd, [temp])).status).toBe("ok");
    });
  });

  it("checks the file it actually opened: a directory swapped for a link after the checks is refused (0.4.1)", async () => {
    await withSandbox(async ({ cwd, temp, elsewhere }) => {
      writeFileSync(join(cwd, "shot.png"), PNG_BYTES);
      writeFileSync(join(elsewhere, "secret.png"), PNG_BYTES);
      // The checks see workspace/shot.png; the open lands on elsewhere/secret.png.
      const swapped = trackedIo({ swap: join(elsewhere, "secret.png") });
      expect(await read("shot.png", cwd, [temp], "agent-1", swapped.io)).toEqual({ status: "outside" });
      expect(swapped.bytesRead()).toBe(0);
      // Without /proc (macOS, BSD): the open file must be the one the checked path names now (dev/ino).
      const noProc = trackedIo({ swap: join(elsewhere, "secret.png"), noProc: true });
      expect(await read("shot.png", cwd, [temp], "agent-1", noProc.io)).toEqual({ status: "outside" });
      expect(noProc.bytesRead()).toBe(0);
      // An honest open passes both ways.
      expect((await read("shot.png", cwd, [temp], "agent-1", trackedIo().io)).status).toBe("ok");
      expect((await read("shot.png", cwd, [temp], "agent-1", trackedIo({ noProc: true }).io)).status).toBe("ok");
    });
  });

  it("reports not-found for missing files and directories inside the roots", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      expect((await read(join(cwd, "missing.png"), cwd, [temp])).status).toBe("not-found");
      expect((await read(cwd, cwd, [temp])).status).toBe("not-found");
    });
  });

  it("does not block on a FIFO", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const fifo = join(cwd, "pipe.png");
      execFileSync("mkfifo", [fifo]);
      expect((await read(fifo, cwd, [temp])).status).toBe("not-found");
    });
  });

  it("reports not-image for text files after reading only their first bytes, and does not tell their size (0.4.1)", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      writeFileSync(join(cwd, "notes.md"), "# hello\n");
      expect(await read("notes.md", cwd, [temp])).toEqual({ status: "not-image" });
      writeFileSync(join(cwd, "log.png"), "x".repeat(2 * 1024 * 1024));
      const tracked = trackedIo();
      expect(await read("log.png", cwd, [temp], "agent-1", tracked.io)).toEqual({ status: "not-image" });
      expect(tracked.bytesRead()).toBeLessThanOrEqual(IMAGE_HEADER_BYTES);
      writeFileSync(join(cwd, "empty.png"), "");
      expect(await read("empty.png", cwd, [temp])).toEqual({ status: "not-image" });
    });
  });

  it("reports too-large without reading the file", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const file = join(cwd, "huge.png");
      writeFileSync(file, Buffer.alloc(MAX_READ_IMAGE_BYTES + 1, 0));
      const tracked = trackedIo();
      expect(await read(file, cwd, [temp], "agent-1", tracked.io)).toEqual({ status: "too-large" });
      expect(tracked.bytesRead()).toBe(0);
    });
  });

  it("stops at 3 MB and one byte when the file grew after its size was checked (0.4.1)", async () => {
    await withSandbox(async ({ cwd, temp }) => {
      const file = join(cwd, "growing.png");
      writeFileSync(file, PNG_BYTES);
      // fstat says 12 bytes; the file is 4 MB by the time it is read.
      const tracked = trackedIo({ grow: MAX_READ_IMAGE_BYTES + 1_000_000 });
      expect(await read(file, cwd, [temp], "agent-1", tracked.io)).toEqual({ status: "too-large" });
      expect(tracked.bytesRead()).toBeLessThanOrEqual(IMAGE_HEADER_BYTES + MAX_READ_IMAGE_BYTES + 1);
    });
  });

  it("allows the system temp directory by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-image-default-"));
    try {
      writeFileSync(join(dir, "shot.png"), PNG_BYTES);
      const result = await handleReadImage({ filePath: join(dir, "shot.png"), agentId: "agent-1" }, contextWithCwd("/nonexistent-workspace"));
      expect(result.status).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

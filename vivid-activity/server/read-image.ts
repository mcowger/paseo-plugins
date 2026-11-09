import { constants } from "node:fs";
import { open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  IMAGE_HEADER_BYTES,
  MAX_READ_IMAGE_BYTES,
  detectImageMimeType,
  type ReadImageResult,
} from "../shared/read-image.js";

type ReadImageInput = { filePath: string; agentId: string };

/** The part of an open file the preview uses. */
export type ImageFile = Pick<FileHandle, "fd" | "stat" | "read" | "close">;

/** File access of the preview; tests replace it to simulate races. */
export interface ReadImageIo {
  open(path: string, flags: number): Promise<ImageFile>;
  /** The path the kernel holds for an open descriptor; null where the platform cannot tell. */
  fdPath(fd: number): Promise<string | null>;
}

const NODE_IO: ReadImageIo = {
  open: (path, flags) => open(path, flags),
  fdPath: (fd) => (process.platform === "linux" ? readlink(`/proc/self/fd/${fd}`).catch(() => null) : Promise.resolve(null)),
};

/** Reads are made in pieces of this size, so a file that grows while it is read cannot make one read bigger. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Resolves a read detail path against the agent cwd. Returns null when unresolvable. */
export function resolveAbsolutePath(
  filePath: string,
  agentCwd: string | null | undefined,
): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return trimmed;
  if (!agentCwd) return null;
  return resolve(agentCwd, trimmed);
}

/** True when `target` is `root` itself or below it (both absolute; `..` segments are resolved first). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The system temp directory, where agents and the tools they run put screenshots: `os.tmpdir()`, which is $TMPDIR and
 * otherwise /tmp on Linux. 0.4.1: /tmp is no longer added everywhere. macOS keeps it: os.tmpdir() is the per-user
 * /var/folders/…/T there, while agents and browser tools write their screenshots to /tmp (/private/tmp), and those
 * previews would stop working without it. A temp directory that is the file system root or holds the home directory
 * would open that whole tree, so such a $TMPDIR is ignored.
 */
export function defaultTempRoots(
  platform: NodeJS.Platform = process.platform,
  temp: string = tmpdir(),
  home: string = homedir(),
): string[] {
  const candidates = platform === "darwin" ? [temp, "/tmp"] : [temp];
  const homeDir = isAbsolute(home) && resolve(home) !== parse(resolve(home)).root ? resolve(home) : null;
  const roots = candidates
    .filter((root) => isAbsolute(root))
    .map((root) => resolve(root))
    .filter((root) => root !== parse(root).root && !(homeDir && isInside(root, homeDir)));
  return [...new Set(roots)];
}

/**
 * 本地补丁：图片预览只读 Agent 工作目录和临时目录里的文件。上游会读取任意绝对路径的图片，
 * 任何能调用插件 RPC 的客户端都能借它读出主机上的图片。符号链接按真实路径判断。
 */
export async function imageRoots(agentCwd: string | null, tempRoots: readonly string[]): Promise<{ lexical: string[]; real: string[] }> {
  const lexical = [agentCwd, ...tempRoots].filter((root): root is string => Boolean(root) && isAbsolute(root!)).map((root) => resolve(root));
  const real = await Promise.all(lexical.map((root) => realpath(root).catch(() => null)));
  return {
    lexical: [...new Set(lexical)],
    real: [...new Set(real.filter((root): root is string => root !== null))],
  };
}

/**
 * The Agent whose working directory bounds a preview. 0.4.1: Paseo shows a provider subagent (a Claude Code background
 * task, say) in a pane of its own and gives its rows the id `provider:<parent agent id>:<subagent id>`, both
 * URI-encoded. The daemon has no Agent by that id; the subagent works in its parent's directory, so the parent stands in.
 */
export function previewAgentId(agentId: string): string {
  const match = /^provider:([^:]+):([^:]+)$/.exec(agentId);
  if (!match) return agentId;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return agentId;
  }
}

async function resolveAgentCwd(
  paseo: PluginHandlerContext["paseo"],
  agentId: string | undefined,
): Promise<string | null> {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return null;
  try {
    // fetch_agent reads the stored record of an Agent that is not loaded; it does not load it.
    const ref = paseo.agents.ref(previewAgentId(id));
    await ref.refresh();
    const cwd = ref.cwd;
    return typeof cwd === "string" && isAbsolute(cwd) ? cwd : null;
  } catch {
    return null;
  }
}

/** Reads from the start of the file, at most `maxBytes` (0.4.1: never the whole file at once). */
export async function readUpTo(file: Pick<FileHandle, "read">, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - total));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
}

/**
 * 0.4.1: whether the file that was opened is still inside the allowed roots. realpath() and open() are separate steps,
 * and O_NOFOLLOW covers only the last component: a directory on the path could be swapped for a link in between. Linux
 * names the file a descriptor really points at (/proc/self/fd). Elsewhere the path that was checked must still be
 * canonical and name the very file that is open (same device and inode); that narrows the window but cannot close it.
 */
async function openedInside(file: ImageFile, realPath: string, realRoots: readonly string[], io: ReadImageIo): Promise<boolean> {
  const kernelPath = await io.fdPath(file.fd);
  if (kernelPath !== null) return isAbsolute(kernelPath) && realRoots.some((root) => isInside(root, kernelPath));
  try {
    const opened = await file.stat();
    if ((await realpath(realPath)) !== realPath) return false;
    const named = await stat(realPath);
    return named.dev === opened.dev && named.ino === opened.ino;
  } catch {
    return false;
  }
}

export async function handleReadImage(
  input: ReadImageInput,
  context: PluginHandlerContext,
  tempRoots: readonly string[] = defaultTempRoots(),
  io: ReadImageIo = NODE_IO,
): Promise<ReadImageResult> {
  // 0.4.1: an Agent the daemon knows is required. Its working directory and the temp directories are the only places
  // a preview reads; without one nothing is read, not even the temp directory.
  const agentCwd = await resolveAgentCwd(context.paseo, input.agentId);
  if (!agentCwd) return { status: "unavailable" };
  const absolutePath = resolveAbsolutePath(input.filePath, agentCwd);
  if (!absolutePath) return { status: "unavailable" };

  const roots = await imageRoots(agentCwd, tempRoots);
  // Refuse before touching the file system, so outside paths do not reveal whether they exist.
  if (![...roots.lexical, ...roots.real].some((root) => isInside(root, absolutePath))) return { status: "outside" };
  let realPath: string;
  try {
    realPath = await realpath(absolutePath);
  } catch {
    return { status: "not-found" };
  }
  if (!roots.real.some((root) => isInside(root, realPath))) return { status: "outside" };

  // Only regular files: opening a FIFO or device would block or stream forever.
  try {
    const fileStat = await stat(realPath);
    if (!fileStat.isFile()) return { status: "not-found" };
    if (fileStat.size > MAX_READ_IMAGE_BYTES) return { status: "too-large" };
  } catch {
    return { status: "not-found" };
  }
  // One handle for the final checks and the read; O_NOFOLLOW / O_NONBLOCK refuse a last component swapped
  // for a link or a FIFO after the checks above.
  let file: ImageFile;
  try {
    file = await io.open(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { status: "not-found" };
  }
  let bytes: Buffer;
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) return { status: "not-found" };
    if (fileStat.size > MAX_READ_IMAGE_BYTES) return { status: "too-large" };
    if (!(await openedInside(file, realPath, roots.real, io))) return { status: "outside" };
    // 0.4.1: look at the first bytes first; a file that does not start like an image is not read any further.
    const head = await readUpTo(file, IMAGE_HEADER_BYTES);
    if (!detectImageMimeType(head, fileStat.size)) return { status: "not-image" };
    // Never more than the limit and one byte, even if the file grew since fstat.
    bytes = await readUpTo(file, MAX_READ_IMAGE_BYTES + 1);
  } catch {
    return { status: "not-found" };
  } finally {
    await file.close().catch(() => undefined);
  }
  if (bytes.byteLength > MAX_READ_IMAGE_BYTES) return { status: "too-large" };

  const mimeType = detectImageMimeType(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!mimeType) return { status: "not-image" };
  return { status: "ok", data: bytes.toString("base64"), mimeType, byteSize: bytes.byteLength };
}

import { stat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  MAX_READ_IMAGE_BYTES,
  detectImageMimeType,
  type ReadImageResult,
} from "../shared/read-image.js";

type ReadImageInput = { filePath: string; agentId?: string };

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

async function resolveAgentCwd(
  paseo: PluginHandlerContext["paseo"],
  agentId: string | undefined,
): Promise<string | null> {
  if (!agentId) return null;
  try {
    const ref = paseo.agents.ref(agentId);
    await ref.refresh();
    return ref.cwd;
  } catch {
    return null;
  }
}

export async function handleReadImage(
  input: ReadImageInput,
  context: PluginHandlerContext,
): Promise<ReadImageResult> {
  const absolutePath = resolveAbsolutePath(
    input.filePath,
    await resolveAgentCwd(context.paseo, input.agentId),
  );
  if (!absolutePath) return { status: "unavailable" };

  let size: number;
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) return { status: "not-found" };
    size = fileStat.size;
  } catch {
    return { status: "not-found" };
  }

  if (size > MAX_READ_IMAGE_BYTES) return { status: "too-large", byteSize: size };
  if (size === 0) return { status: "not-image", byteSize: 0 };

  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    return { status: "not-found" };
  }

  const mimeType = detectImageMimeType(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!mimeType) return { status: "not-image", byteSize: bytes.byteLength };
  return { status: "ok", data: bytes.toString("base64"), mimeType, byteSize: bytes.byteLength };
}

import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { ompMcpResultRpc } from "../shared/omp-mcp-result.js";

type Input = { agentId: string; callId: string };
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LINES = 100_000;
const MAX_TEXT = 1024 * 1024;

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function findSessionFile(root: string, sessionId: string): Promise<string | null> {
  let cwdEntries;
  try { cwdEntries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const cwd of cwdEntries) {
    if (cwd.isSymbolicLink() || !cwd.isDirectory()) continue;
    const directory = join(root, cwd.name);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(`_${sessionId}.jsonl`)) {
        return join(directory, entry.name);
      }
    }
  }
  return null;
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < limit) {
    const length = Math.min(chunk.length, limit - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    position += bytesRead;
  }
  if (position === limit) {
    const probe = Buffer.alloc(1);
    if ((await handle.read(probe, 0, 1, position)).bytesRead > 0) return null;
  }
  return Buffer.concat(chunks, position);
}

type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  details?: { xdev?: { tool?: string; mode?: string } };
  content: unknown[];
};

function messageRecord(value: unknown): value is { type: "message"; message: ToolResultMessage } {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "message" ||
    !("message" in value) || !value.message || typeof value.message !== "object") return false;
  const message = value.message;
  return "role" in message && message.role === "toolResult" && "toolCallId" in message &&
    typeof message.toolCallId === "string" && "toolName" in message && typeof message.toolName === "string" &&
    "content" in message && Array.isArray(message.content);
}

function supportedResult(message: ToolResultMessage): boolean {
  if (message.toolName === "grep") return true;
  if (message.toolName !== "write" || !message.details || typeof message.details !== "object" ||
    !("xdev" in message.details) || !message.details.xdev || typeof message.details.xdev !== "object" ||
    !("tool" in message.details.xdev) || typeof message.details.xdev.tool !== "string") return false;
  const xdev = message.details.xdev;
  return message.details.xdev.tool.startsWith("mcp__") ||
    ("mode" in xdev && xdev.mode === "execute");
}

export async function handleOmpMcpResult(input: Input, context: PluginHandlerContext): Promise<z.output<typeof ompMcpResultRpc.output>> {
  try {
    const ref = context.paseo.agents.ref(input.agentId);
    const refreshed = await ref.refresh();
    const agent = refreshed?.agent as { provider?: string; runtimeInfo?: { sessionId?: string } } | undefined;
    if (agent?.provider !== "omp") return { text: null };
    const sessionId = agent.runtimeInfo?.sessionId;
    if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { text: null };
    const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
    const sessions = join(base, "sessions");
    const root = await realpath(sessions);
    const file = await findSessionFile(root, sessionId);
    if (!file) return { text: null };
    const resolved = await realpath(file);
    if (!inside(root, resolved)) return { text: null };
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return { text: null };
      const content = await readBounded(handle, MAX_FILE_BYTES);
      if (!content) return { text: null };
      let lines = 0;
      for (const line of content.toString("utf8").split("\n")) {
        if (++lines > MAX_LINES) break;
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        if (!messageRecord(record) || record.message.toolCallId !== input.callId ||
          !supportedResult(record.message)) continue;
        const text = record.message.content.filter((item): item is { type: "text"; text: string } =>
          !!item && typeof item === "object" && "type" in item && item.type === "text" &&
          "text" in item && typeof item.text === "string").map((item) => item.text).join("\n");
        if (!text) return { text: null };
        return { text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[truncated]` : text };
      }
    } finally { await handle.close(); }
    return { text: null };
  } catch { return { text: null }; }
}


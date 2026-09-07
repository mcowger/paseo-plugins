import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const JSONL_RPC_DEFAULT_TIMEOUT_MS = 30_000;
/** Pass as timeoutMs to wait only for a response, process death, or close(). */
export const JSONL_RPC_NO_TIMEOUT = null;

const STDERR_BUFFER_LIMIT = 8192;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

const V2_FRAME_BYTES = 1024 * 1024;
const V2_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const V2_CHUNK_BYTES = 256 * 1024;
const V2_BASE64_CHARS = Math.ceil(V2_CHUNK_BYTES / 3) * 4;
const V2_MAX_CHUNKS = Math.ceil(V2_REASSEMBLED_BYTES / V2_CHUNK_BYTES);

export type JsonlFrameProblem =
  | "invalid-json"
  | "invalid-chunk"
  | "invalid-base64"
  | "out-of-order-chunk"
  | "chunk-length-mismatch"
  | "invalid-chunk-payload";

interface ChunkHeader {
  id: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface ChunkAssembly {
  id: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
  bytes: number;
}

function objectFrame(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function chunkHeader(frame: Record<string, unknown>): ChunkHeader | null {
  const { chunkId, index, count, byteLength, data } = frame;
  if (
    typeof chunkId !== "string" ||
    chunkId.length === 0 ||
    chunkId.length > 128 ||
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 2 ||
    count > V2_MAX_CHUNKS ||
    index >= count ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < V2_FRAME_BYTES ||
    byteLength > V2_REASSEMBLED_BYTES ||
    typeof data !== "string" ||
    data.length === 0
  ) {
    return null;
  }
  return { id: chunkId, index, count, byteLength, data };
}

function chunkBytes(data: string): Buffer | null {
  if (data.length > V2_BASE64_CHARS) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > V2_CHUNK_BYTES || bytes.toString("base64") !== data) return null;
  return bytes;
}

export class JsonlFrameDecoder {
  private lineBuffer = "";
  private assembly: ChunkAssembly | null = null;

  constructor(
    private readonly receiver: {
      frame(message: Record<string, unknown>): void;
      problem(problem: JsonlFrameProblem, detail?: unknown): void;
    },
  ) {}

  write(text: string): void {
    this.lineBuffer += text;
    let newline = this.lineBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.trim()) this.consumeLine(line);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.receiver.problem("invalid-json", { error, line });
      return;
    }
    const frame = objectFrame(parsed);
    if (!frame) return;
    if (frame.type !== "rpc_chunk") {
      this.receiver.frame(frame);
      return;
    }
    this.consumeChunk(frame);
  }

  private consumeChunk(frame: Record<string, unknown>): void {
    const header = chunkHeader(frame);
    if (!header) {
      this.drop("invalid-chunk", frame);
      return;
    }
    const bytes = chunkBytes(header.data);
    if (!bytes) {
      this.drop("invalid-base64");
      return;
    }
    if (!this.assembly) {
      if (header.index !== 0) {
        this.receiver.problem("out-of-order-chunk");
        return;
      }
      this.assembly = {
        id: header.id,
        count: header.count,
        byteLength: header.byteLength,
        parts: [],
        bytes: 0,
      };
    }
    const assembly = this.assembly;
    if (
      assembly.id !== header.id ||
      assembly.count !== header.count ||
      assembly.byteLength !== header.byteLength ||
      assembly.parts.length !== header.index
    ) {
      this.drop("out-of-order-chunk");
      return;
    }
    assembly.parts.push(bytes);
    assembly.bytes += bytes.byteLength;
    if (assembly.bytes > assembly.byteLength) {
      this.drop("chunk-length-mismatch");
      return;
    }
    if (assembly.parts.length < assembly.count) return;
    this.assembly = null;
    if (assembly.bytes !== assembly.byteLength) {
      this.receiver.problem("chunk-length-mismatch");
      return;
    }
    this.finishAssembly(assembly.parts);
  }

  private finishAssembly(parts: Buffer[]): void {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
      const frame = objectFrame(JSON.parse(text));
      if (frame) this.receiver.frame(frame);
      else this.receiver.problem("invalid-chunk-payload");
    } catch (error) {
      this.receiver.problem("invalid-chunk-payload", error);
    }
  }

  private drop(problem: JsonlFrameProblem, detail?: unknown): void {
    this.assembly = null;
    this.receiver.problem(problem, detail);
  }
}

export interface JsonlRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

interface JsonlRpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface JsonlRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
}

export interface JsonlRpcProcessOptions {
  launch: JsonlRpcLaunch;
  diagnosticName?: string;
  defaultRequestTimeoutMs?: number;
  spawn?: (launch: JsonlRpcLaunch) => ChildProcessWithoutNullStreams;
  onProblem?: (problem: JsonlFrameProblem, detail?: unknown) => void;
}

function spawnJsonlRpcProcess(launch: JsonlRpcLaunch): ChildProcessWithoutNullStreams {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env ? { ...process.env, ...launch.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("JSONL RPC process was spawned without stdio streams");
  }
  return child;
}

export class JsonlRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly diagnosticName: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageSubscribers = new Set<(message: Record<string, unknown>) => void>();
  private readonly exitSubscribers = new Set<(exit: JsonlRpcExit) => void>();
  private stderrBuffer = "";
  private nextRequestId = 1;
  private disposed = false;
  private readonly frameDecoder: JsonlFrameDecoder;

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.diagnosticName = options.diagnosticName ?? "JSONL RPC";
    this.frameDecoder = new JsonlFrameDecoder({
      frame: (message) => this.dispatchFrame(message),
      problem: (problem, detail) => {
        this.options.onProblem?.(problem, detail);
      },
    });
    this.child = (options.spawn ?? spawnJsonlRpcProcess)(options.launch);
    this.child.stdout.on("data", (chunk) => {
      this.frameDecoder.write(chunk.toString());
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    this.child.stdin.on("error", (error) => {
      this.handleStdinError(error);
    });
    this.child.on("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `${this.diagnosticName} process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
      );
      const exit = { code, signal, error };
      for (const subscriber of this.exitSubscribers) {
        subscriber(exit);
      }
      this.failAll(error);
    });
  }

  onMessage(callback: (message: Record<string, unknown>) => void): () => void {
    this.messageSubscribers.add(callback);
    return () => {
      this.messageSubscribers.delete(callback);
    };
  }

  onExit(callback: (exit: JsonlRpcExit) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  startRequest(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): { id: string; promise: Promise<unknown> } {
    if (this.disposed) {
      return {
        id: "",
        promise: Promise.reject(new Error(`${this.diagnosticName} process is closed`)),
      };
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    const requestTimeoutMs =
      timeoutMs === undefined
        ? (this.options.defaultRequestTimeoutMs ?? JSONL_RPC_DEFAULT_TIMEOUT_MS)
        : timeoutMs;
    const startedAt = Date.now();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = createRequestTimeout(requestTimeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.diagnosticName} request timed out phase=${command.type} elapsedMs=${Date.now() - startedAt} timeoutMs=${requestTimeoutMs}\n${this.stderrBuffer}`.trim(),
          ),
        );
      });
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
    return { id, promise };
  }

  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(message: Record<string, unknown>): void {
    if (this.disposed) {
      return;
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.handleStdinError(new Error(`${this.diagnosticName} stdin is not writable`));
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.handleStdinError(error);
    }
  }

  async close(error = new Error(`${this.diagnosticName} process is closed`)): Promise<void> {
    if (this.disposed) return;
    this.failAll(error);
    try {
      this.child.stdin.end();
    } catch {
      // Ignore cleanup races.
    }
    await this.terminate();
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => "exited" as const),
      delay(GRACEFUL_SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
    ]);
    if (graceful === "exited") return;

    child.kill("SIGKILL");
    await Promise.race([exited, delay(FORCE_SHUTDOWN_TIMEOUT_MS)]);
  }

  private dispatchFrame(message: Record<string, unknown>): void {
    if (message.type === "response") {
      this.handleResponse(message as unknown as JsonlRpcResponse);
      return;
    }
    for (const subscriber of this.messageSubscribers) {
      subscriber(message);
    }
  }

  private handleResponse(response: JsonlRpcResponse): void {
    if (!response.id) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(response.id);
    if (!response.success) {
      pending.reject(
        new Error(
          response.error ?? `${this.diagnosticName} ${response.command ?? "request"} failed`,
        ),
      );
      return;
    }
    pending.resolve(response.data);
  }

  private handleStdinError(error: unknown): void {
    if (this.disposed) {
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    void this.close(err);
  }

  private failAll(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function createRequestTimeout(
  timeoutMs: number | null,
  onTimeout: () => void,
): NodeJS.Timeout | null {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return setTimeout(onTimeout, timeoutMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

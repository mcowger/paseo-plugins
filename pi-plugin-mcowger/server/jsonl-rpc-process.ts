import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { JsonlFrameDecoder } from "./jsonl-frame-decoder.js";

export const JSONL_RPC_NO_TIMEOUT = null;
const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_LIMIT = 8_192;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface JsonlRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

export interface JsonlRpcProcessOptions {
  launch: JsonlRpcLaunch;
  requestTimeoutMs?: number;
  onWarning?(message: string, error?: unknown): void;
}

export class JsonlRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messages = new Set<(message: Record<string, unknown>) => void>();
  private readonly exits = new Set<(error: Error) => void>();
  private readonly decoder: JsonlFrameDecoder;
  private stderr = "";
  private nextRequestId = 1;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  private resolveExited: () => void = () => undefined;

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.child = spawn(options.launch.command, options.launch.args, {
      cwd: options.launch.cwd,
      env: options.launch.env ? { ...process.env, ...options.launch.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.decoder = new JsonlFrameDecoder({
      frame: (frame) => this.dispatch(frame),
      problem: (problem, detail) => this.options.onWarning?.(`Ignoring invalid Pi RPC frame: ${problem}`, detail),
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.decoder.write(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-STDERR_LIMIT);
    });
    this.child.stdin.on("error", (error) => this.fail(new Error(`Pi RPC stdin failed: ${error.message}`)));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.resolveExited();
      this.fail(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}${this.stderr ? `\n${this.stderr}` : ""}`));
    });
  }

  onMessage(listener: (message: Record<string, unknown>) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  startRequest(command: Record<string, unknown>, timeoutMs?: number | null): { id: string; promise: Promise<unknown> } {
    const id = `req_${this.nextRequestId++}`;
    if (this.closed) return { id, promise: Promise.reject(new Error("Pi RPC session is closed")) };
    const timeout = timeoutMs === undefined ? (this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS) : timeoutMs;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = timeout === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC request timed out: ${String(command.type)}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
    return { id, promise };
  }

  request(command: Record<string, unknown>, timeoutMs?: number | null): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(frame: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.fail(new Error("Pi RPC stdin is not writable"));
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async close(reason = new Error("Pi RPC session is closed")): Promise<void> {
    this.shutdownPromise ??= this.terminate(reason);
    await this.shutdownPromise;
  }

  private async terminate(reason: Error): Promise<void> {
    this.fail(reason);
    try {
      this.child.stdin.end();
    } catch {
      // stdin may already be closed after a process failure.
    }
    this.signalProcessTree("SIGTERM");
    if (await this.waitForExit(GRACEFUL_SHUTDOWN_TIMEOUT_MS)) return;
    this.options.onWarning?.("Pi RPC process did not exit after SIGTERM; sending SIGKILL");
    this.signalProcessTree("SIGKILL");
    await this.waitForExit(FORCE_SHUTDOWN_TIMEOUT_MS);
  }

  private signalProcessTree(signal: NodeJS.Signals): void {
    if (this.child.pid && process.platform !== "win32") {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        // The process may have exited or may not have formed a process group yet.
      }
    }
    if (!this.child.killed) this.child.kill(signal);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    return await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private dispatch(frame: Record<string, unknown>): void {
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (frame.success !== true) {
        pending.reject(new Error(typeof frame.error === "string" ? frame.error : "Pi RPC request failed"));
      } else {
        pending.resolve(frame.data);
      }
      return;
    }
    for (const listener of this.messages) listener(frame);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.exits) listener(error);
  }
}

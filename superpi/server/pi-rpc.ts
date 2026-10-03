import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Pi subprocess JSONL transport.
 *
 * One instance owns exactly one `pi --mode rpc` process. The transport is
 * deliberately protocol-agnostic: it frames UTF-8 JSONL records, correlates
 * `type: "response"` records by ID, delivers every inbound record to listeners
 * (including responses, so callers can observe events that precede responses),
 * and treats process/transport failure as terminal.
 *
 * `request` resolves the response's `data` on `success: true` and rejects with
 * a `PiRpcCommandError` (carrying the full response) on `success: false`.
 * Transport-level failures use the other exported error classes.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_PENDING_REQUESTS = 1_024;
/**
 * Largest tolerated unterminated stdout frame. Pi echoes prompt images as
 * base64, so the ceiling must clear the aggregate prompt-image budget plus JSON
 * framing overhead; 64 MiB keeps a full echo comfortably inside one frame.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const STDERR_TAIL_BYTES = 256 * 1024;
export const CLOSE_GRACE_MS = 2_000;
export const SIGTERM_GRACE_MS = 3_000;
export const SIGKILL_GRACE_MS = 1_000;
/** Bounded TERM->KILL grace for sweeping the process group after the leader is gone. */
export const GROUP_SWEEP_GRACE_MS = 250;

export type PiRecord = Record<string, unknown>;
export type PiRecordListener = (record: PiRecord) => void;
export type PiExitListener = (error: Error) => void;

export interface PiRpcOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onRecord?: PiRecordListener;
}

export interface PiRpc {
  readonly pid: number | undefined;
  /** Send a command and resolve its response `data` (rejects on `success:false`). */
  request(command: PiRecord, timeoutMs?: number): Promise<unknown>;
  /** Write a raw record (for example `extension_ui_response`) without awaiting a reply. */
  send(record: PiRecord): Promise<void>;
  /** Subscribe to every inbound record, including correlated responses. */
  onRecord(listener: PiRecordListener): () => void;
  /** Observe terminal transport failure (unexpected exit, broken pipe, bad framing). */
  onExit(listener: PiExitListener): () => void;
  /** Bounded, redacted stderr tail for diagnostics. */
  diagnosticTail(): string;
  /** Idempotent shutdown with bounded escalation and process-group cleanup. */
  close(): Promise<void>;
}

export class PiRpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PiRpcError";
  }
}

export class PiRpcTransportError extends PiRpcError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PiRpcTransportError";
  }
}

export class PiRpcTimeoutError extends PiRpcError {
  constructor(message: string) {
    super(message);
    this.name = "PiRpcTimeoutError";
  }
}

export class PiRpcClosedError extends PiRpcError {
  constructor(message: string) {
    super(message);
    this.name = "PiRpcClosedError";
  }
}

export class PiRpcExitError extends PiRpcError {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PiRpcExitError";
    this.code = code;
    this.signal = signal;
  }
}

export class PiRpcCommandError extends PiRpcError {
  readonly response: PiRecord;

  constructor(response: PiRecord) {
    super(
      `Pi command ${String(response.command ?? "unknown")} failed: ${String(response.error ?? "unknown error")}`,
    );
    this.name = "PiRpcCommandError";
    this.response = response;
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

function collectSecrets(env: NodeJS.ProcessEnv | undefined): string[] {
  if (!env) return [];
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(key)) secrets.push(value);
  }
  return secrets;
}

function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) output = output.split(secret).join("[redacted]");
  output = output.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  output = output.replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  return output;
}

export function createPiRpc(options: PiRpcOptions): Promise<PiRpc> {
  const mergedEnv = { ...process.env, ...options.env };
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  const secrets = collectSecrets(mergedEnv);
  const recordListeners = new Set<PiRecordListener>();
  const exitListeners = new Set<PiExitListener>();
  const pending = new Map<string, PendingRequest>();
  const exitWaiters = new Set<() => void>();
  const decoder = new StringDecoder("utf8");

  let stdoutBuffer = "";
  let stdoutBytes = 0;
  let stderrTail = "";
  let stderrTailBytes = 0;
  let nextId = 1;
  let state: "starting" | "open" | "closing" | "closed" | "failed" = "starting";
  let failure: Error | null = null;
  let exited = false;
  let closePromise: Promise<void> | null = null;

  if (options.onRecord) recordListeners.add(options.onRecord);

  const isOpen = (): boolean => state === "open" && failure === null;

  function closedError(): PiRpcClosedError {
    return new PiRpcClosedError("Pi RPC transport is not open");
  }

  function rejectAllPending(error: Error): void {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function notifyExit(error: Error): void {
    for (const listener of exitListeners) {
      try {
        listener(error);
      } catch {
        // Listener failures must not break transport teardown.
      }
    }
  }

  function fail(error: Error): void {
    if (failure || state === "closing" || state === "closed") return;
    failure = error;
    state = "failed";
    rejectAllPending(error);
    notifyExit(error);
  }

  function handleRecord(record: PiRecord): void {
    for (const listener of recordListeners) {
      try {
        listener(record);
      } catch {
        // A listener must not be able to stall framing.
      }
    }
    if (record.type !== "response" || record.id === undefined || record.id === null) return;
    const key = String(record.id);
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (record.success === false) entry.reject(new PiRpcCommandError(record));
    else entry.resolve(record.data);
  }

  function dispatchLine(line: string): void {
    if (line.length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(new PiRpcTransportError(`Pi emitted a non-JSON stdout record: ${line.slice(0, 200)}`, { cause: error }));
      return;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail(new PiRpcTransportError("Pi emitted a non-object stdout record"));
      return;
    }
    handleRecord(record as PiRecord);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += decoder.write(chunk);
    stdoutBytes += chunk.byteLength;
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const raw = stdoutBuffer.slice(0, newlineIndex + 1);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      stdoutBytes -= Buffer.byteLength(raw, "utf8");
      const line = raw.slice(0, -1);
      dispatchLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      if (state === "failed") return;
    }
    if (stdoutBytes > MAX_FRAME_BYTES) {
      fail(new PiRpcTransportError(`Pi stdout frame exceeded ${MAX_FRAME_BYTES} bytes without a newline`));
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrTail += text;
    stderrTailBytes += chunk.byteLength;
    if (stderrTailBytes > STDERR_TAIL_BYTES) {
      stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
      stderrTailBytes = Buffer.byteLength(stderrTail, "utf8");
    }
  });

  child.stdin.on("error", (error: Error) => {
    fail(new PiRpcTransportError(`Pi stdin error: ${error.message}`, { cause: error }));
  });

  child.on("error", (error: Error) => {
    fail(new PiRpcTransportError(`Pi process error: ${error.message}`, { cause: error }));
  });

  child.on("exit", (code, signal) => {
    exited = true;
    for (const waiter of exitWaiters) waiter();
    exitWaiters.clear();
    const error = new PiRpcExitError(
      `Pi process exited (code=${code ?? "null"}, signal=${signal ?? "null"})${stderrTail ? `\n${diagnosticTail().slice(-8_192)}` : ""}`,
      code,
      signal,
    );
    if (state === "starting" || state === "open") fail(error);
    else rejectAllPending(error);
  });

  child.on("close", () => {
    const remainder = stdoutBuffer + decoder.end();
    stdoutBuffer = "";
    stdoutBytes = 0;
    if (remainder.length > 0) {
      const line = remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder;
      dispatchLine(line);
    }
    exited = true;
    for (const waiter of exitWaiters) waiter();
    exitWaiters.clear();
    if (state !== "failed") state = "closed";
  });

  function send(record: PiRecord): Promise<void> {
    if (!isOpen()) return Promise.reject(closedError());
    let payload: string;
    try {
      payload = `${JSON.stringify(record)}\n`;
    } catch (error) {
      return Promise.reject(new PiRpcTransportError("Pi RPC record is not JSON-serializable", { cause: error }));
    }
    return new Promise<void>((resolve, reject) => {
      if (!isOpen()) {
        reject(closedError());
        return;
      }
      try {
        child.stdin.write(payload, (error) => {
          if (error) reject(new PiRpcTransportError(`Failed to write to Pi stdin: ${error.message}`, { cause: error }));
          else resolve();
        });
      } catch (error) {
        reject(
          new PiRpcTransportError(
            `Failed to write to Pi stdin: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        );
      }
    });
  }

  function request(command: PiRecord, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!isOpen()) return Promise.reject(closedError());
    if (pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new PiRpcTransportError(`Too many pending Pi RPC requests (limit ${MAX_PENDING_REQUESTS})`),
      );
    }
    const id = command.id !== undefined && command.id !== null ? command.id : `superpi-${nextId++}`;
    const key = String(id);
    if (pending.has(key)) {
      return Promise.reject(new PiRpcTransportError(`Duplicate Pi RPC request id: ${key}`));
    }
    const record: PiRecord = { ...command, id };
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!pending.delete(key)) return;
              reject(
                new PiRpcTimeoutError(
                  `Pi RPC request ${key} (type=${String(command.type ?? "unknown")}) timed out after ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs)
          : null;
      pending.set(key, { resolve, reject, timer });
      void send(record).catch((error: Error) => {
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(error);
      });
    });
  }

  function onRecord(listener: PiRecordListener): () => void {
    recordListeners.add(listener);
    return () => {
      recordListeners.delete(listener);
    };
  }

  function onExit(listener: PiExitListener): () => void {
    exitListeners.add(listener);
    return () => {
      exitListeners.delete(listener);
    };
  }

  function diagnosticTail(): string {
    return redact(stderrTail, secrets);
  }

  function waitForExit(ms: number): Promise<boolean> {
    if (exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const waiter = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        exitWaiters.delete(waiter);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        exitWaiters.delete(waiter);
        resolve(false);
      }, ms);
      exitWaiters.add(waiter);
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }


  function endStdin(): Promise<void> {
    return new Promise<void>((resolve) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        resolve();
        return;
      }
      try {
        stdin.end(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  function killTree(signal: NodeJS.Signals): void {
    const pid = child.pid;
    try {
      if (pid !== undefined && process.platform !== "win32") process.kill(-pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process is already gone.
      }
    }
  }

  /** Whether the owned process group still has any member (node:process.kill semantics). */
  function groupExists(): boolean {
    if (process.platform === "win32") return false;
    const pid = child.pid;
    if (pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  async function waitForGroupExit(ms: number): Promise<boolean> {
    await sleep(ms);
    return !groupExists();
  }

  /**
   * A detached Pi can leave tool descendants in its process group after the
   * leader exits, so a confirmed leader death is not enough. Sweep the group
   * with a bounded TERM->KILL escalation, ignoring an already-empty group
   * (ESRCH) and never resolving as if cleanup happened when it did not.
   */
  async function sweepProcessGroup(): Promise<void> {
    if (!groupExists()) return;
    killTree("SIGTERM");
    if (await waitForGroupExit(GROUP_SWEEP_GRACE_MS)) return;
    killTree("SIGKILL");
    await waitForGroupExit(GROUP_SWEEP_GRACE_MS);
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    state = "closing";
    rejectAllPending(new PiRpcClosedError("Pi RPC transport is closing"));
    closePromise = (async () => {
      let unconfirmed: PiRpcTransportError | undefined;
      if (!exited) {
        await Promise.race([endStdin(), sleep(CLOSE_GRACE_MS)]);
        if (!(await waitForExit(CLOSE_GRACE_MS))) {
          killTree("SIGTERM");
          if (!(await waitForExit(SIGTERM_GRACE_MS))) {
            killTree("SIGKILL");
            if (!(await waitForExit(SIGKILL_GRACE_MS))) {
              unconfirmed = new PiRpcTransportError(
                "Pi process termination could not be confirmed after shutdown escalation",
              );
            }
          }
        }
      }
      if (unconfirmed) {
        // The leader is not confirmed dead; claiming a descendant sweep would
        // be a false promise, so report the unconfirmed outcome instead.
        throw unconfirmed;
      }
      // Confirmed (or already-observed) leader exit: sweep any detached
      // descendants that inherited the owned process group.
      await sweepProcessGroup();
      state = "closed";
    })();
    return closePromise;
  }

  const api: PiRpc = {
    get pid() {
      return child.pid;
    },
    request,
    send,
    onRecord,
    onExit,
    diagnosticTail,
    close,
  };

  return new Promise<PiRpc>((resolve, reject) => {
    child.once("spawn", () => {
      state = "open";
      resolve(api);
    });
    child.once("error", (error: Error) => {
      reject(
        new PiRpcTransportError(`Failed to launch Pi (${options.command}): ${error.message}`, { cause: error }),
      );
    });
  });
}

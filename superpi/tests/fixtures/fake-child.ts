import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { vi } from "vitest";

export interface FakeChildController {
  readonly chunks: string[];
  setManual(manual: boolean): void;
  release(): void;
  failNext(error: Error): void;
}

export interface FakeChild extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  control: FakeChildController;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
}

/**
 * In-memory stand-in for a spawned Pi process. The module under test spawns
 * through `node:child_process`, so tests pair this with a mocked `spawn` and
 * drive stdout/stderr/exit deterministically.
 */
export function createFakeChild(pid = 999_999): FakeChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: string[] = [];
  const pendingCallbacks: Array<(error?: Error | null) => void> = [];
  let manual = false;
  let nextError: Error | null = null;

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      if (nextError) {
        const error = nextError;
        nextError = null;
        callback(error);
        return;
      }
      if (manual) pendingCallbacks.push(callback);
      else callback();
    },
  });

  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);
  child.control = {
    chunks,
    setManual(value: boolean) {
      manual = value;
    },
    release() {
      for (const callback of pendingCallbacks.splice(0)) callback();
    },
    failNext(error: Error) {
      nextError = error;
    },
  };
  child.exit = (code, signal = null) => {
    child.emit("exit", code, signal);
    child.emit("close");
  };

  return child;
}

/** Write one JSONL record to the fake process stdout. */
export function emitRecord(child: FakeChild, record: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(record)}\n`);
}

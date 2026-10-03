import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChild, emitRecord, type FakeChild } from "./fixtures/fake-child";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  CLOSE_GRACE_MS,
  GROUP_SWEEP_GRACE_MS,
  MAX_FRAME_BYTES,
  MAX_PENDING_REQUESTS,
  PiRpcClosedError,
  PiRpcCommandError,
  PiRpcExitError,
  PiRpcTimeoutError,
  PiRpcTransportError,
  SIGTERM_GRACE_MS,
  SIGKILL_GRACE_MS,
  STDERR_TAIL_BYTES,
  createPiRpc,
  type PiRecord,
  type PiRpcOptions,
} from "../server/pi-rpc";

function sentRecords(child: FakeChild): PiRecord[] {
  return child.control.chunks.map((chunk) => JSON.parse(chunk) as PiRecord);
}

async function startRpc(options: Partial<PiRpcOptions> = {}): Promise<{ rpc: Awaited<ReturnType<typeof createPiRpc>>; child: FakeChild }> {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child);
  const promise = createPiRpc({
    command: "pi",
    args: ["--mode", "rpc"],
    cwd: "/tmp/superpi",
    ...options,
  });
  child.emit("spawn");
  return { rpc: await promise, child };
}

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("launch and environment", () => {
  it("launches with the daemon environment overlaid by explicit env", async () => {
    const previous = process.env.SUPERPI_TEST_BASE;
    process.env.SUPERPI_TEST_BASE = "daemon";
    try {
      const { rpc, child } = await startRpc({ env: { SUPERPI_TEST_OVERLAY: "explicit" } });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, args, rawOptions] = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }];
      expect(command).toBe("pi");
      expect(args).toEqual(["--mode", "rpc"]);
      expect(rawOptions.cwd).toBe("/tmp/superpi");
      expect(rawOptions.env.SUPERPI_TEST_BASE).toBe("daemon");
      expect(rawOptions.env.SUPERPI_TEST_OVERLAY).toBe("explicit");
      expect(rawOptions.env.PATH).toBe(process.env.PATH);
      child.exit(0, null);
      await rpc.close();
    } finally {
      if (previous === undefined) delete process.env.SUPERPI_TEST_BASE;
      else process.env.SUPERPI_TEST_BASE = previous;
    }
  });

  it("rejects creation when the process fails to spawn", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = createPiRpc({ command: "missing-pi", cwd: "/tmp" });
    child.emit("error", new Error("ENOENT"));
    await expect(promise).rejects.toBeInstanceOf(PiRpcTransportError);
  });
});

describe("UTF-8 JSONL framing", () => {
  it("decodes records split across chunks and accepts CRLF terminators", async () => {
    const { rpc, child } = await startRpc();
    const received: PiRecord[] = [];
    rpc.onRecord((record) => received.push(record));

    const record = { type: "event", text: "héllo → 🙂" };
    const bytes = Buffer.from(`${JSON.stringify(record)}\r\n`, "utf8");
    child.stdout.write(bytes.subarray(0, 3));
    child.stdout.write(bytes.subarray(3, 7));
    child.stdout.write(bytes.subarray(7));

    expect(received).toEqual([record]);
    child.exit(0, null);
    await rpc.close();
  });

  it("fails the transport on a non-JSON stdout record", async () => {
    const { rpc, child } = await startRpc();
    const failures = vi.fn();
    rpc.onExit(failures);
    const pending = rpc.request({ type: "get_state" });
    child.stdout.write("this is not json\n");
    await expect(pending).rejects.toBeInstanceOf(PiRpcTransportError);
    expect(failures).toHaveBeenCalledTimes(1);
    await expect(rpc.request({ type: "again" })).rejects.toBeInstanceOf(PiRpcClosedError);
  });

  it("fails when an incomplete stdout frame exceeds the bound", async () => {
    const { rpc, child } = await startRpc();
    const failures = vi.fn();
    rpc.onExit(failures);
    child.stdout.write("x".repeat(MAX_FRAME_BYTES + 1));
    expect(failures).toHaveBeenCalledTimes(1);
    await expect(rpc.request({ type: "get_state" })).rejects.toBeInstanceOf(PiRpcClosedError);
  });
});

describe("correlation", () => {
  it("resolves response data by id regardless of response order", async () => {
    const { rpc, child } = await startRpc();
    const first = rpc.request({ type: "alpha" });
    const second = rpc.request({ type: "beta" });
    const sent = sentRecords(child);
    expect(sent).toHaveLength(2);

    emitRecord(child, { type: "response", id: sent[1]?.id, command: "beta", success: true, data: { n: 2 } });
    emitRecord(child, { type: "response", id: sent[0]?.id, command: "alpha", success: true, data: { n: 1 } });

    expect(await first).toEqual({ n: 1 });
    expect(await second).toEqual({ n: 2 });
    child.exit(0, null);
    await rpc.close();
  });

  it("delivers events that precede their response to record listeners", async () => {
    const { rpc, child } = await startRpc();
    const seen: string[] = [];
    rpc.onRecord((record) => seen.push(String(record.type)));
    const pending = rpc.request({ type: "get_state" });
    const id = sentRecords(child)[0]?.id;

    emitRecord(child, { type: "agent_start" });
    emitRecord(child, { type: "response", id, command: "get_state", success: true, data: { ok: true } });

    expect(await pending).toEqual({ ok: true });
    expect(seen).toEqual(["agent_start", "response"]);
    child.exit(0, null);
    await rpc.close();
  });

  it("rejects with the full response on success:false", async () => {
    const { rpc, child } = await startRpc();
    const pending = rpc.request({ type: "set_model" });
    const id = sentRecords(child)[0]?.id;
    emitRecord(child, { type: "response", id, command: "set_model", success: false, error: "Model not found" });

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason as PiRpcCommandError,
    );
    expect(error).toBeInstanceOf(PiRpcCommandError);
    expect(error?.response.error).toBe("Model not found");
    child.exit(0, null);
    await rpc.close();
  });

  it("times out a request and ignores a late response", async () => {
    vi.useFakeTimers();
    const { rpc, child } = await startRpc();
    const failures = vi.fn();
    rpc.onExit(failures);
    const pending = rpc.request({ type: "slow" }, 1_000);
    const id = sentRecords(child)[0]?.id;
    const rejected = expect(pending).rejects.toBeInstanceOf(PiRpcTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    emitRecord(child, { type: "response", id, command: "slow", success: true, data: { late: true } });
    expect(failures).not.toHaveBeenCalled();
    child.exit(0, null);
    await rpc.close();
  });

  it("bounds the number of pending requests", async () => {
    const { rpc, child } = await startRpc();
    const accepted: Array<Promise<unknown>> = [];
    for (let index = 0; index < MAX_PENDING_REQUESTS; index += 1) {
      accepted.push(rpc.request({ type: "noop" }, 0));
    }
    await expect(rpc.request({ type: "overflow" }, 0)).rejects.toBeInstanceOf(PiRpcTransportError);
    child.exit(0, null);
    await Promise.allSettled(accepted);
    expect(rpc.diagnosticTail()).toBeTypeOf("string");
  });
});

describe("stdin backpressure", () => {
  it("waits for the stdin write to flush before resolving send", async () => {
    const { rpc, child } = await startRpc();
    child.control.setManual(true);
    let settled = false;
    const pending = rpc.send({ type: "raw" }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.control.chunks).toHaveLength(1);

    child.control.release();
    await pending;
    expect(settled).toBe(true);
    child.exit(0, null);
    await rpc.close();
  });

  it("rejects sends and requests once close has started", async () => {
    vi.useFakeTimers();
    const { rpc, child } = await startRpc();
    const closing = rpc.close();
    await expect(rpc.send({ type: "raw" })).rejects.toBeInstanceOf(PiRpcClosedError);
    await expect(rpc.request({ type: "get_state" })).rejects.toBeInstanceOf(PiRpcClosedError);
    child.exit(0, null);
    await closing;
  });
});

describe("diagnostics", () => {
  it("includes redacted startup diagnostics in exit failures", async () => {
    const secret = "sk-private-diagnostic-secret";
    const { rpc, child } = await startRpc({ env: { SUPERPI_API_KEY: secret } });
    const failure = rpc.request({ type: "get_state" }).catch((error: unknown) => error);
    child.stderr.write(`Missing extension configuration: ${secret}\n`);
    child.exit(1, null);
    const error = await failure as Error;
    expect(error.message).toContain("Missing extension configuration");
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("[redacted]");
  });
  it("keeps a bounded, redacted stderr tail", async () => {
    const secret = "sk-live-abcdefghijklmnop";
    const { rpc, child } = await startRpc({ env: { SUPERPI_API_KEY: secret } });
    child.stderr.write(`auth ${secret}\n`);
    child.stderr.write(`Bearer ${secret}\n`);
    const tail = rpc.diagnosticTail();
    expect(tail).not.toContain(secret);
    expect(tail).toContain("[redacted]");

    child.stderr.write("z".repeat(STDERR_TAIL_BYTES + 10));
    expect(Buffer.byteLength(rpc.diagnosticTail(), "utf8")).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    child.exit(0, null);
    await rpc.close();
  });
});

describe("exit and shutdown", () => {
  it("does not claim successful cleanup when process termination cannot be confirmed", async () => {
    vi.useFakeTimers();
    const { rpc } = await startRpc();
    vi.spyOn(process, "kill").mockReturnValue(true);
    const outcome = rpc.close().then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS + SIGTERM_GRACE_MS + SIGKILL_GRACE_MS);
    expect(await outcome).toBeInstanceOf(PiRpcTransportError);
    expect((await outcome as Error).message).toContain("could not be confirmed");
  });
  it("rejects pending requests and reports failure on unexpected exit", async () => {
    const { rpc, child } = await startRpc();
    const failures: Error[] = [];
    rpc.onExit((error) => failures.push(error));
    const pending = rpc.request({ type: "get_state" });
    child.exit(1, null);

    await expect(pending).rejects.toBeInstanceOf(PiRpcExitError);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(PiRpcExitError);
    await expect(rpc.request({ type: "again" })).rejects.toBeInstanceOf(PiRpcClosedError);
  });

  it("closes idempotently and escalates from SIGTERM to SIGKILL with process-group cleanup", async () => {
    vi.useFakeTimers();
    const { rpc, child } = await startRpc();
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("ESRCH") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    const first = rpc.close();
    const second = rpc.close();
    expect(first).toBe(second);

    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");

    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.exit(null, "SIGKILL");
    await first;
    await second;
    await expect(rpc.close()).resolves.toBeUndefined();
  });
});

describe("post-exit process-group sweep", () => {
  it("signals owned descendants after the leader already exited", async () => {
    vi.useFakeTimers();
    const { rpc, child } = await startRpc();
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    child.exit(0, null);
    const closing = rpc.close();
    await vi.advanceTimersByTimeAsync(GROUP_SWEEP_GRACE_MS * 2 + 50);
    await closing;
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });

  it("treats an already-gone process group (ESRCH) as cleaned up", async () => {
    const { rpc, child } = await startRpc();
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("ESRCH") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    child.exit(0, null);
    await expect(rpc.close()).resolves.toBeUndefined();
    expect(processKill).toHaveBeenCalledWith(-child.pid, 0);
  });
});

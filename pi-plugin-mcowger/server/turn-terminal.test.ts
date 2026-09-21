import { describe, expect, test } from "vitest";

import {
  checkTerminalKey,
  decideLegacyTerminal,
  shouldHonorNoTurnAck,
} from "./turn-terminal.js";

describe("checkTerminalKey", () => {
  test("matches the active prompt request id", () => {
    expect(checkTerminalKey("req-1", "req-1")).toBe("match");
  });

  test("discards keyed mismatch before any transition", () => {
    expect(checkTerminalKey("req-stale", "req-2")).toBe("mismatch");
  });

  test("defers keyed signals while the ack is pending", () => {
    expect(checkTerminalKey("req-1", null)).toBe("ack-pending");
  });

  test("marks signals without a request id as unkeyed", () => {
    expect(checkTerminalKey(undefined, "req-1")).toBe("unkeyed");
    expect(checkTerminalKey(undefined, null)).toBe("unkeyed");
  });
});

describe("decideLegacyTerminal", () => {
  const idle = {
    hasFreshCapturedEntry: true,
    hasCurrentTurnActivity: true,
    runtimeIdle: true,
    runtimeCompacting: false,
    hasConflictingWork: false,
  };

  test("accepts full ordered evidence", () => {
    expect(decideLegacyTerminal(idle)).toEqual({ kind: "accept" });
  });

  test("ignores ambiguous-active terminals", () => {
    expect(decideLegacyTerminal({ ...idle, hasConflictingWork: true })).toEqual({ kind: "ignore" });
    expect(decideLegacyTerminal({ ...idle, runtimeIdle: false })).toEqual({ kind: "ignore" });
    expect(decideLegacyTerminal({ ...idle, runtimeCompacting: true })).toEqual({ kind: "ignore" });
  });

  test("fails only the turn on confirmed-idle ambiguity", () => {
    expect(decideLegacyTerminal({ ...idle, hasFreshCapturedEntry: false })).toEqual({
      kind: "failTurn",
    });
    expect(decideLegacyTerminal({ ...idle, hasCurrentTurnActivity: false })).toEqual({
      kind: "failTurn",
    });
  });
});

describe("shouldHonorNoTurnAck", () => {
  test("honors agentInvoked:false with no native activity", () => {
    expect(shouldHonorNoTurnAck(false)).toBe(true);
  });

  test("ignores agentInvoked:false after contradictory activity", () => {
    expect(shouldHonorNoTurnAck(true)).toBe(false);
  });
});

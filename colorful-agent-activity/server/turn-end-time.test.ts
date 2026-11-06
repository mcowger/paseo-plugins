import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";

describe("turn end timestamps", () => {
  it("records an end timestamp only when enabled", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue({ status: "ready", values: { timestamps: false } });
    let listener: ((event: unknown, context: unknown) => Promise<void>) | undefined;
    const server = {
      registerSettings: () => ({ read }),
      handle: vi.fn(),
      on: (_name: string, fn: typeof listener) => { listener = fn; return () => {}; },
    } as unknown as PluginServerContext;
    contribute(server);
    const context = { paseo: { agents: { ref: () => ({ timeline: { append } }) } } };
    const event = { agent: { id: "agent" }, turnId: "turn-1" };
    await listener?.(event, context);
    expect(append).not.toHaveBeenCalled();
    read.mockResolvedValue({ status: "ready", values: { timestamps: true } });
    await listener?.(event, context);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0][0]).toMatchObject({ kind: "turn-end-time", data: { at: expect.any(Number) } });
  });
});

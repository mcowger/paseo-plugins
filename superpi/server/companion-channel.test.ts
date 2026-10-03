import { describe, expect, it } from "vitest";
import { createCompanionChannel } from "./companion-channel.js";
import { companionPrefix } from "../shared/companion.js";

function fixture() {
  const listeners = new Set<(record: Record<string, unknown>) => void>();
  const commands: Record<string, unknown>[] = [];
  const emit = (reply: unknown) => {
    for (const listener of listeners) listener({ type: "extension_ui_request", method: "notify", message: companionPrefix + JSON.stringify(reply) });
  };
  const rpc = {
    onRecord(listener: (record: Record<string, unknown>) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(command: Record<string, unknown>): Promise<unknown> {
      commands.push(command);
      if (command.type === "get_commands") return { commands: [] };
      const encoded = (command.message as string).split(" ")[1]!;
      const request = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Record<string, unknown>;
      emit({ ...request, sessionKey: "stale-generation", ok: true, data: "stale" });
      emit({ ...request, ok: true, data: { confirmed: true } });
      return { disposition: "handled" };
    },
  };
  return { rpc, commands, listeners };
}

describe("companion channel", () => {
  it("requires command registration before invoking a potentially unknown slash command", async () => {
    const { rpc, commands } = fixture();
    const channel = createCompanionChannel(rpc, "generation");
    await expect(channel.verify()).rejects.toThrow("did not load");
    expect(commands).toEqual([{ type: "get_commands" }]);
    channel.close();
  });

  it("correlates notifications before RPC replies and ignores stale identities", async () => {
    const { rpc, listeners } = fixture();
    const channel = createCompanionChannel(rpc, "generation");
    expect(await channel.request("hello")).toEqual({ confirmed: true });
    channel.close();
    channel.close();
    expect(listeners.size).toBe(0);
    await expect(channel.request("hello")).rejects.toThrow("closed");
  });

  it("times out without inventing success or a model execution lifetime", async () => {
    const { rpc } = fixture();
    rpc.request = async () => ({ disposition: "handled" });
    const channel = createCompanionChannel(rpc, "generation", 10);
    await expect(channel.request("hello")).rejects.toThrow("uncertain");
    channel.close();
  });
});

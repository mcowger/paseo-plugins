import { describe, expect, it } from "vitest";
import { FOLD_MEMORY } from "./fold-runtime";
import { createLatestRows, forgetWith } from "./latest-rows";

describe("latest row times per Agent (0.5.0)", () => {
  it("keeps the newest time, tells listeners only about a newer one, and forgets an Agent", () => {
    const rows = createLatestRows();
    let heard = 0;
    const stop = rows.subscribe(() => void heard++);
    rows.note("agent-1", 2_000);
    rows.note("agent-1", 1_000);
    rows.note("agent-1", 2_000);
    expect(rows.get("agent-1")).toBe(2_000);
    expect(heard).toBe(1);
    expect(rows.get("agent-2")).toBe(0);
    rows.forget("agent-1");
    expect(rows.get("agent-1")).toBe(0);
    expect(rows.size()).toBe(0);
    stop();
    rows.note("agent-1", 3_000);
    expect(heard).toBe(1);
  });

  it("drops the older half once more Agents than FOLD_MEMORY.latestAgents are kept", () => {
    const rows = createLatestRows();
    for (let index = 0; index <= FOLD_MEMORY.latestAgents; index++) rows.note(`agent-${index}`, index + 1);
    expect(rows.size()).toBeLessThanOrEqual(FOLD_MEMORY.latestAgents);
    expect(rows.get("agent-0")).toBe(0);
    expect(rows.get(`agent-${FOLD_MEMORY.latestAgents}`)).toBe(FOLD_MEMORY.latestAgents + 1);
  });

  it("drops an Agent from every store when the fold runtime forgets it", () => {
    let forget: ((agentId: string) => void) | null = null;
    let stopped = false;
    const runtime = {
      onForget(listener: (agentId: string) => void) {
        forget = listener;
        return () => void (stopped = true);
      },
    };
    const reasoning = createLatestRows();
    const tools = createLatestRows();
    reasoning.note("agent-1", 1);
    tools.note("agent-1", 2);
    tools.note("agent-2", 3);
    const stop = forgetWith(runtime, [reasoning, tools]);
    forget!("agent-1");
    expect([reasoning.size(), tools.size(), tools.get("agent-2")]).toEqual([0, 1, 3]);
    stop();
    expect(stopped).toBe(true);
  });
});

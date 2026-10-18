import { describe, expect, it } from "vitest";
import { toolOutputPayload, toolOutputText } from "./tool-output";

describe("tool result envelopes", () => {
  it("reads the host's content-block shape", () => {
    const output = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "ignored" },
        { type: "text", text: "second" },
      ],
    };
    expect(toolOutputText(output)).toBe("first\nsecond");
  });

  it("reads Pi's string-content shape", () => {
    // Pi's ToolResultMessage has no structuredContent field, so this is the only wrapper
    // a plugin provider ever sees.
    const output = { content: "the payload", details: { server: "exa", tool: "search" } };
    expect(toolOutputText(output)).toBe("the payload");
    expect(toolOutputPayload(output)).toBe("the payload");
  });

  it("parses JSON text, including JSON after a line of prose", () => {
    expect(toolOutputPayload({ content: '{"a":1}' })).toEqual({ a: 1 });
    expect(toolOutputPayload({ content: 'count=2\n\n{"a":1}' })).toEqual({ a: 1 });
    expect(toolOutputPayload({ content: "plain prose" })).toBe("plain prose");
  });

  it("returns nothing to unwrap rather than blanking a row", () => {
    expect(toolOutputPayload(undefined)).toBeUndefined();
    expect(toolOutputPayload(null)).toBeUndefined();
    expect(toolOutputPayload({})).toBeUndefined();
    expect(toolOutputPayload({ details: { server: "x" } })).toBeUndefined();
  });

  it("keeps structured content that holds no text", () => {
    expect(toolOutputPayload({ structuredContent: { total_count: 2 } })).toEqual({
      total_count: 2,
    });
    expect(toolOutputPayload({ structuredContent: { content: '{"total_count":2}' } })).toEqual({
      total_count: 2,
    });
  });

  it("stops nesting instead of looping on a self-referential envelope", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.structuredContent = cyclic;
    // Terminates on the depth cap and hands back what it could not unwrap.
    expect(toolOutputPayload(cyclic)).toBe(cyclic);
  });
});

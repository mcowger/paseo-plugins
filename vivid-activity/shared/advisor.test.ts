import { describe, expect, it } from "vitest";
import { isAdvisorTool, parseAdvisorNotes } from "./advisor";

describe("Advisor notes", () => {
  it("recognizes only the synthetic advisor tool", () => {
    expect(isAdvisorTool(" advisor ")).toBe(true);
    expect(isAdvisorTool("advise")).toBe(false);
    expect(isAdvisorTool("functions.advisor")).toBe(false);
  });

  it("parses severity and advisor names in Paseo's joined notes", () => {
    expect(parseAdvisorNotes("[nit] [reviewer] Rename this.\n\n[concern] Race condition.\n\n[blocker] [security] Stop here.")).toEqual([
      { severity: "nit", advisor: "reviewer", text: "Rename this." },
      { severity: "concern", text: "Race condition." },
      { severity: "blocker", advisor: "security", text: "Stop here." },
    ]);
  });

  it("defaults missing severity to nit and keeps ambiguous unmarked paragraphs together", () => {
    expect(parseAdvisorNotes("[reviewer] First paragraph\n\nSecond paragraph\n\n[blocker] Next note")).toEqual([
      { severity: "nit", advisor: "reviewer", text: "First paragraph\n\nSecond paragraph" },
      { severity: "blocker", text: "Next note" },
    ]);
    expect(parseAdvisorNotes("Raw fallback text\n\nMore detail")).toEqual([
      { severity: "nit", text: "Raw fallback text\n\nMore detail" },
    ]);
  });

  it("preserves multiline markdown and severity markers inside fenced code", () => {
    const text = "[concern] Example:\n\n```text\n\n[blocker] not a note\n```\n\n- item\n  continuation\n\n[blocker] Real issue";
    expect(parseAdvisorNotes(text)).toEqual([
      { severity: "concern", text: "Example:\n\n```text\n\n[blocker] not a note\n```\n\n- item\n  continuation" },
      { severity: "blocker", text: "Real issue" },
    ]);
  });

  it("recognizes a fence immediately after a note header", () => {
    expect(parseAdvisorNotes("[concern] ```ts\ncode\n```\n\n[blocker] Stop")).toEqual([
      { severity: "concern", text: "```ts\ncode\n```" },
      { severity: "blocker", text: "Stop" },
    ]);
    expect(parseAdvisorNotes("[reviewer] ```ts\ncode\n```\n\n[blocker] Stop")).toEqual([
      { severity: "nit", advisor: "reviewer", text: "```ts\ncode\n```" },
      { severity: "blocker", text: "Stop" },
    ]);
  });

  it("handles CRLF, empty text, and incomplete prefixes without losing text", () => {
    expect(parseAdvisorNotes("[nit] One\r\n\r\n[concern] Two")).toEqual([
      { severity: "nit", text: "One" }, { severity: "concern", text: "Two" },
    ]);
    expect(parseAdvisorNotes("  \n ")).toEqual([]);
    expect(parseAdvisorNotes("[blocker]")).toEqual([{ severity: "blocker", text: "[blocker]" }]);
  });
});

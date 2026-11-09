import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { askContent, expansionTargetForToolCall, isAskTool, normalizeToolCallDetail, resolveToolCallPresentation } from "./presentation";
import { lookFor, pendingCallIds, pendingCalls, rowLabel, rowMotion, statusLooks, washAlpha } from "./vivid-model";

// Rows from Paseo 0.11.1's own Claude and Codex mappers, and the permission requests those providers raise
// (artifacts/.../gen-attention-fixtures.mjs).
type Row = { callId: string; name: string; status: string; detail: ToolCallDetail };
const fixtures = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/attention-0.11.1.json"), "utf8")) as Record<string, Row & { kind?: string; metadata?: Record<string, unknown> }>;
const row = (name: string) => fixtures[name] as Row;
const request = (name: string) => fixtures[name] as { kind: string; metadata: Record<string, unknown> };

describe("which row waits for you (opus-F48, opus-F54)", () => {
  it("matches Codex approvals and questions by item id, like Claude's tool-use id and ACP's tool-call id", () => {
    // Codex app-server requests carry only { itemId, threadId, turnId }; the row's callId is that same item id.
    const codexCommand = pendingCalls([request("codexCommandRequest")]);
    expect(codexCommand.ids.has(row("codexCommandRunning").callId)).toBe(true);
    expect(codexCommand.questions.size).toBe(0);
    const codexQuestion = pendingCalls([request("codexQuestionRequest")]);
    expect(codexQuestion.ids.has(row("codexQuestionRunning").callId)).toBe(true);
    expect(codexQuestion.questions.has(row("codexQuestionRunning").callId)).toBe(true);
    expect(pendingCallIds([request("claudeAskRequest"), { metadata: { toolCallId: "acp-1" } }])).toEqual(new Set(["toolu_ask_1", "acp-1"]));
    // OpenCode's question names its call as callID.
    expect(pendingCallIds([{ kind: "question", metadata: { source: "opencode_question", messageID: "msg_1", callID: "call_1" } }])).toEqual(new Set(["call_1"]));
    expect(pendingCallIds([{ metadata: {} }, null, undefined, { metadata: { itemId: "" } }])).toEqual(new Set());
  });

  it("tells a question (等你回答) from an approval (等你批准)", () => {
    const both = pendingCalls([request("claudeAskRequest"), request("claudeEditRequest")]);
    expect([...both.ids].sort()).toEqual(["toolu_ask_1", "toolu_edit_1"]);
    expect([...both.questions]).toEqual(["toolu_ask_1"]);
    expect(both.onlyQuestions).toBe(false);
    expect(pendingCalls([request("claudeAskRequest")]).onlyQuestions).toBe(true);
    expect(pendingCalls([]).onlyQuestions).toBe(false);
    expect(statusLooks.question).toEqual({ label: "等你回答", hue: "amber", icon: "MessageCircleQuestionMark" });
    expect(statusLooks.waiting).toMatchObject({ label: "等你批准", icon: "Hand" });
    expect(rowMotion({ status: "question", statusChanges: 0, finishes: 0, live: false })).toMatchObject({ ping: true, spin: false });
    expect(washAlpha("question", true)).toBeGreaterThan(0);
    expect(rowLabel({ expanded: false, title: "提问", summary: "用哪种数据库？", status: "question" })).toBe("展开 提问 用哪种数据库？，等你回答");
  });
});

describe("ask-the-user tools are 提问 (opus-F54)", () => {
  it("knows the ask tools of every provider by name", () => {
    for (const name of ["ask", "AskUserQuestion", "mcp__omp__ask", "ask_user_question", "ask_user", "request_user_input", "request_user_input_async", "question", "functions.request_user_input"]) {
      expect(isAskTool(name), name).toBe(true);
    }
    for (const name of ["Bash", "ask_later", "questions", "mcp__github__search_code"]) expect(isAskTool(name), name).toBe(false);
  });

  it("draws Claude's AskUserQuestion and Codex's request_user_input as amber 提问 with the question as summary", () => {
    for (const name of ["claudeAskRunning", "claudeAskCompleted", "codexQuestionRunning"]) {
      const item = row(name);
      const detail = normalizeToolCallDetail(item.detail, item.name);
      const presentation = resolveToolCallPresentation({ name: item.name, detail });
      expect(presentation, name).toMatchObject({ category: "communication", icon: "MessageCircleQuestionMark", label: "Ask Question", summary: "用哪种数据库？" });
      expect(lookFor(item.name, detail, presentation), name).toBe("ask");
      // 「提问：默认收起」 applies to them now (Codex's used to auto-expand as plain text).
      expect(expansionTargetForToolCall(item.name, detail.type), name).toBe("ask");
    }
  });

  it("reads the questions, options and answers", () => {
    const claude = normalizeToolCallDetail(row("claudeAskCompleted").detail, "AskUserQuestion");
    expect(askContent(claude)).toEqual({
      questions: [{ header: "数据库", question: "用哪种数据库？", options: ["PostgreSQL", "SQLite"], multiSelect: false }],
      answers: [{ question: "用哪种数据库？", answer: "PostgreSQL" }],
    });
    expect(askContent(normalizeToolCallDetail(row("claudeAskRunning").detail, "AskUserQuestion")).answers).toEqual([]);
    expect(askContent(row("codexQuestionRunning").detail)).toEqual({
      questions: [{ header: "数据库", question: "用哪种数据库？", options: ["PostgreSQL", "SQLite"], multiSelect: false }],
      answers: [],
    });
    // A completed Codex question lists the answers after "Answers:".
    expect(askContent({ type: "plain_text", text: "数据库: 用哪种数据库？\nOptions: PostgreSQL, SQLite\n\nAnswers:\n\ndb: PostgreSQL" }).answers).toEqual([{ question: "db", answer: "PostgreSQL" }]);
    expect(askContent({ type: "unknown", input: null, output: null })).toEqual({ questions: [], answers: [] });
  });
});

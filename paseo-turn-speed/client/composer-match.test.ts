import assert from "node:assert/strict";
import test from "node:test";
import { matchComposer } from "./composer-match";

test("keeps the uniquely matched agent when sending clears both drafts", () => {
  const ids = ["first", "second"];
  const draft = { context: "agent", agent: "same settings", prompt: "explain this" };
  const empty = { ...draft, prompt: "" };
  const before = { first: [draft], second: [empty] };
  const sent = new Map<string, string | null>([["first", null], ["second", null]]);
  const selected = matchComposer(draft, ids, before, sent, null);
  assert.equal(selected, "first");
  sent.set("first", draft.prompt);
  assert.equal(matchComposer(empty, ids, before, sent, selected), "first");
  const after = { first: [empty], second: [empty] };
  assert.equal(matchComposer(empty, ids, after, sent, selected), "first");
  assert.equal(matchComposer(empty, ids, after, sent, null), null);
});

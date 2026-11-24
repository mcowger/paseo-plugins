import assert from "node:assert/strict";
import test from "node:test";
import { parentAgentIdOf, PARENT_AGENT_ID_LABEL } from "./links";

test("parent comes from the paseo.parent-agent-id label", () => {
  assert.equal(parentAgentIdOf({ labels: { [PARENT_AGENT_ID_LABEL]: " p-1 " } }), "p-1");
});

test("label wins over a stale field", () => {
  assert.equal(
    parentAgentIdOf({ labels: { [PARENT_AGENT_ID_LABEL]: "p-1" }, parentAgentId: "p-2" }),
    "p-1",
  );
});

test("bare parentAgentId field works as a fallback", () => {
  assert.equal(parentAgentIdOf({ labels: {}, parentAgentId: "p-2" }), "p-2");
});

test("empty, blank or absent labels mean no parent", () => {
  assert.equal(parentAgentIdOf({ labels: { [PARENT_AGENT_ID_LABEL]: "  " } }), null);
  assert.equal(parentAgentIdOf({ labels: { [PARENT_AGENT_ID_LABEL]: "" }, parentAgentId: "" }), null);
  assert.equal(parentAgentIdOf({}), null);
  assert.equal(parentAgentIdOf({ labels: null }), null);
});

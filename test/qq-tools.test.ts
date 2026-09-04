import assert from "node:assert/strict";
import test from "node:test";

import { QQ_TOOL_DEFINITIONS, createQqToolRunner } from "../qq-tools.js";
import type { ConversationSummary, QqToolDeps } from "../qq-tools.js";
import type { LlmToolUseBlock } from "../llm-client.js";

// The tools that move Holly's attention. The property worth defending is that
// focus is not something the model can assert — it can ask to move it, and only
// open_conversation moves it. send_message therefore has no target argument, so
// a hallucinated group id has nowhere to land.

const CONVERSATIONS: ConversationSummary[] = [
  { id: "qq_group:100", name: "群甲", unread: 3, lastMessage: "等你的茶", lastAt: "2026-09-04T08:00:00Z" },
  { id: "qq_group:200", name: "群乙", unread: 0, lastMessage: "（无新消息）", lastAt: null },
];

function harness(overrides: Partial<QqToolDeps> = {}) {
  let focus: string | null = null;
  const sent: Array<{ id: string; message: string }> = [];
  const deps: QqToolDeps = {
    listConversations: async () => CONVERSATIONS,
    readConversation: async (id) => (CONVERSATIONS.some((c) => c.id === id) ? [`${id} 的最近消息`] : null),
    sendToConversation: async (id, message) => { sent.push({ id, message }); return "msg_1"; },
    getFocus: () => focus,
    setFocus: (id) => { focus = id; },
    canSend: () => ({ allowed: true, reason: "" }),
    ...overrides,
  };
  const run = createQqToolRunner(deps);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    run({ type: "tool_use", id: "tu_1", name, input } as LlmToolUseBlock).then((raw) => JSON.parse(raw));
  return { call, sent, focus: () => focus };
}

test("the three tools are declared with closed schemas", () => {
  assert.deepEqual(QQ_TOOL_DEFINITIONS.map((t) => t.name), [
    "list_conversations",
    "open_conversation",
    "send_message",
  ]);
  for (const tool of QQ_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} should reject extra args`);
  }
});

// --- list_conversations ----------------------------------------------------

test("list_conversations returns the roster and reports the current focus", async () => {
  const { call } = harness();
  const listed = await call("list_conversations");
  assert.equal(listed.ok, true);
  assert.equal(listed.current, null);
  assert.equal(listed.conversations.length, 2);
});

test("list_conversations does not move focus", async () => {
  const { call, focus } = harness();
  await call("list_conversations");
  assert.equal(focus(), null);
});

// --- open_conversation -----------------------------------------------------

test("open_conversation shows the messages and takes focus", async () => {
  const { call, focus } = harness();
  const opened = await call("open_conversation", { id: "qq_group:100" });
  assert.equal(opened.ok, true);
  assert.equal(opened.current, "qq_group:100");
  assert.deepEqual(opened.recent, ["qq_group:100 的最近消息"]);
  assert.equal(focus(), "qq_group:100");
});

test("opening an unknown conversation refuses and leaves focus alone", async () => {
  const { call, focus } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const missed = await call("open_conversation", { id: "qq_group:999" });
  assert.equal(missed.ok, false);
  // Focus must not be moved to somewhere that does not exist.
  assert.equal(focus(), "qq_group:100");
});

test("open_conversation with no id explains how to get one", async () => {
  const { call } = harness();
  const bad = await call("open_conversation", {});
  assert.equal(bad.ok, false);
  assert.match(bad.note, /list_conversations/);
});

// --- send_message ----------------------------------------------------------

test("send_message goes to whatever is currently open", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:200" });
  const result = await call("send_message", { message: "在的" });
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, "qq_group:200");
  assert.deepEqual(sent, [{ id: "qq_group:200", message: "在的" }]);
});

test("send_message with nothing open refuses instead of guessing a target", async () => {
  const { call, sent } = harness();
  const result = await call("send_message", { message: "在的" });
  assert.equal(result.ok, false);
  assert.match(result.note, /open_conversation/);
  assert.deepEqual(sent, []);
});

test("send_message cannot be aimed by argument", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  // A model that invents a target gets ignored: there is no target parameter,
  // and the extra key is not read.
  await call("send_message", { message: "hi", id: "qq_group:999", conversationId: "qq_group:999" });
  assert.deepEqual(sent, [{ id: "qq_group:100", message: "hi" }]);
});

test("an empty message is refused", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("send_message", { message: "   " });
  assert.equal(result.ok, false);
  assert.deepEqual(sent, []);
});

test("a suppressed send comes back as a result the model can read, not a throw", async () => {
  const { call, sent } = harness({
    canSend: () => ({ allowed: false, reason: "QQ 处于观察模式，不发送。" }),
  });
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("send_message", { message: "在的" });
  assert.equal(result.ok, false);
  assert.match(result.note, /观察模式/);
  assert.deepEqual(sent, []);
});

test("an unknown tool name is refused rather than throwing", async () => {
  const { call } = harness();
  const result = await call("delete_everything", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown tool/);
});

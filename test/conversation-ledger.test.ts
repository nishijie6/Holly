import assert from "node:assert/strict";
import test from "node:test";

import { ConversationLedger } from "../conversation-ledger.js";
import type { LlmToolResultBlock, LlmToolUseBlock } from "../llm-client.js";

// The ledger's value is a promise: nothing rewrites what is already in it, so a
// prompt-cache prefix built from it can only ever extend. These tests pin the
// two halves of that — that appends stay appends, and that the tool_use /
// tool_result pairing cannot be broken from inside.

const use = (id: string, name = "get_weather"): LlmToolUseBlock => ({
  type: "tool_use", id, name, input: {},
});
const result = (toolUseId: string, content = "ok"): LlmToolResultBlock => ({
  type: "tool_result", toolUseId, content,
});

test("a fresh ledger is empty and settled", () => {
  const ledger = new ConversationLedger();
  assert.equal(ledger.size, 0);
  assert.deepEqual([...ledger.pendingToolUses], []);
});

test("appends land in order and the earlier turns are untouched", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("first");
  ledger.appendAssistantTurn("second");
  ledger.appendUserText("third");

  assert.deepEqual(ledger.snapshot().map((m) => `${m.role}:${m.content}`), [
    "user:first",
    "assistant:second",
    "user:third",
  ]);
});

test("append results report their index and the new size", () => {
  const ledger = new ConversationLedger();
  assert.deepEqual(ledger.appendUserText("a"), { index: 0, messageCount: 1 });
  assert.deepEqual(ledger.appendAssistantTurn("b"), { index: 1, messageCount: 2 });
});

test("empty turns are refused rather than silently dropped", () => {
  const ledger = new ConversationLedger();
  assert.throws(() => ledger.appendUserText("   "), /empty user turn/);
  assert.throws(() => ledger.appendAssistantTurn(""), /empty assistant turn/);
});

// --- tool pairing ----------------------------------------------------------

test("a tool call round trip settles the ledger", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("weather?");
  ledger.appendAssistantTurn("checking", [use("tu_1")]);
  assert.deepEqual([...ledger.pendingToolUses], ["tu_1"]);

  ledger.appendToolResults([result("tu_1", "18C")]);
  assert.deepEqual([...ledger.pendingToolUses], []);
  assert.equal(ledger.size, 3);
});

test("prose cannot slip between a tool call and its result", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("weather?");
  ledger.appendAssistantTurn("checking", [use("tu_1")]);
  // Appending here would orphan tu_1 and 400 the next request, far from here.
  assert.throws(() => ledger.appendUserText("never mind"), /still unanswered/);
});

test("a second assistant turn cannot open while calls are outstanding", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("weather?");
  ledger.appendAssistantTurn("checking", [use("tu_1")]);
  assert.throws(() => ledger.appendAssistantTurn("also this"), /still unanswered/);
});

test("every outstanding call must be answered in the same turn", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("both?");
  ledger.appendAssistantTurn("", [use("tu_1"), use("tu_2", "get_time")]);
  assert.throws(() => ledger.appendToolResults([result("tu_1")]), /missing tool_result for tu_2/);
  // Still outstanding: the rejected append changed nothing.
  assert.deepEqual([...ledger.pendingToolUses], ["tu_1", "tu_2"]);

  ledger.appendToolResults([result("tu_1"), result("tu_2")]);
  assert.deepEqual([...ledger.pendingToolUses], []);
});

test("a result for an unknown id is refused", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("weather?");
  ledger.appendAssistantTurn("", [use("tu_1")]);
  assert.throws(() => ledger.appendToolResults([result("tu_1"), result("tu_9")]), /unknown id tu_9/);
});

test("results with nothing outstanding are refused", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("hi");
  assert.throws(() => ledger.appendToolResults([result("tu_1")]), /no tool calls are awaiting/);
});

test("parallel results ride in one turn", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("both?");
  ledger.appendAssistantTurn("", [use("tu_1"), use("tu_2", "get_time")]);
  ledger.appendToolResults([result("tu_1"), result("tu_2")]);

  const last = ledger.snapshot().at(-1);
  assert.equal(last?.role, "user");
  assert.equal(last?.blocks?.length, 2);
});

// --- restore ---------------------------------------------------------------

test("restore seeds an empty ledger", () => {
  const ledger = new ConversationLedger();
  ledger.restore([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ]);
  assert.equal(ledger.size, 2);
  ledger.appendUserText("c");
  assert.equal(ledger.size, 3);
});

test("restore refuses to overwrite a running ledger", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("live");
  assert.throws(() => ledger.restore([{ role: "user", content: "old" }]), /only valid on an empty ledger/);
});

test("restore drops a transcript that ends mid tool call", () => {
  const ledger = new ConversationLedger();
  ledger.restore([
    { role: "user", content: "weather?" },
    { role: "assistant", content: "checking", blocks: [use("tu_1")] },
  ]);
  // The unanswered turn is gone, so the ledger starts settled and the first
  // live append does not throw.
  assert.equal(ledger.size, 1);
  assert.deepEqual([...ledger.pendingToolUses], []);
  ledger.appendUserText("still here?");
  assert.equal(ledger.size, 2);
});

test("restore keeps a transcript that ends on a settled turn", () => {
  const ledger = new ConversationLedger();
  ledger.restore([
    { role: "user", content: "weather?" },
    { role: "assistant", content: "checking", blocks: [use("tu_1")] },
    { role: "user", content: "", blocks: [result("tu_1")] },
  ]);
  assert.equal(ledger.size, 3);
});

// --- the seam Phase 3 depends on -------------------------------------------

test("the tool loop's turn hooks keep a ledger in step, in order", async () => {
  const { runClaudeToolLoop } = await import("../llm-client.js");
  const original = globalThis.fetch;
  const responses: Array<Record<string, unknown>> = [
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: {} },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "18C" }] },
  ];
  let call = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: true, status: 200, headers: new Headers(),
      json: async () => body, text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;

  const ledger = new ConversationLedger();
  ledger.appendUserText("weather?");
  try {
    await runClaudeToolLoop({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [...ledger.snapshot()],
      tools: [{ name: "get_weather", description: "w", inputSchema: { type: "object" } }],
      runTool: async () => "18C",
      recordUsage: () => {},
      onAssistantTurn: (text, toolUses) => ledger.appendAssistantTurn(text, toolUses),
      onToolResults: (results) => ledger.appendToolResults(results),
    });
  } finally {
    globalThis.fetch = original;
  }

  // The ledger's own pairing checks did not fire, which is the point: the loop
  // hands it turns in an order the ledger considers legal.
  assert.equal(ledger.size, 4);
  assert.deepEqual([...ledger.pendingToolUses], []);
  assert.equal(ledger.snapshot()[1].blocks?.[0].type, "tool_use");
  assert.equal(ledger.snapshot()[2].blocks?.[0].type, "tool_result");
  // 收尾那一轮没有工具调用，只有她说的话。账本对「有话、没有工具」这种回合本来就放行，
  // 循环现在也确实把它交进来了——这条断言守的就是这条新接上的路。
  assert.equal(ledger.snapshot()[3].role, "assistant");
  assert.equal(ledger.snapshot()[3].content, "18C");
  assert.equal(ledger.snapshot()[3].blocks, undefined);
});

// --- compaction, the one sanctioned rewrite --------------------------------

test("compaction replaces the front with a summary and keeps the tail verbatim", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("一");
  ledger.appendUserText("二");
  ledger.appendUserText("三");

  ledger.replaceFrontWithSummary("此前聊了一和二", ledger.snapshot().slice(2));
  assert.deepEqual(ledger.snapshot().map((m) => m.content), ["此前聊了一和二", "三"]);
});

test("the ledger keeps working normally after a compaction", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("一");
  ledger.appendUserText("二");
  ledger.replaceFrontWithSummary("摘要", ledger.snapshot().slice(1));
  ledger.appendAssistantTurn("三");
  assert.deepEqual(ledger.snapshot().map((m) => m.content), ["摘要", "二", "三"]);
});

test("compaction refuses an empty summary", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("一");
  assert.throws(() => ledger.replaceFrontWithSummary("   ", []), /empty summary/);
});

test("compaction refuses to run mid tool call", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("weather?");
  ledger.appendAssistantTurn("", [use("tu_1")]);
  assert.throws(() => ledger.replaceFrontWithSummary("摘要", []), /unanswered/);
});

test("compaction refuses a tail that starts with an orphaned tool_result", () => {
  const ledger = new ConversationLedger();
  ledger.appendUserText("一");
  // The tool_use that this result answers would be summarized away, so the
  // kept half opens with an orphan — a 400 on the very next request.
  assert.throws(
    () => ledger.replaceFrontWithSummary("摘要", [
      { role: "user", content: "", blocks: [result("tu_1")] },
      { role: "user", content: "后续" },
    ]),
    /orphaned tool_result/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LEDGER_COMPACTION_OPTIONS,
  buildLedgerSummaryPrompt,
  planLedgerCompaction,
} from "../ledger-compaction.js";
import { ConversationLedger } from "../conversation-ledger.js";
import type { LlmMessage } from "../llm-client.js";

// Where to cut a transcript. The failure that matters is not "summarized too
// much" — it is a cut landing inside a tool exchange, which the API rejects
// outright on the next request rather than answering worse.

const OPTS = DEFAULT_LEDGER_COMPACTION_OPTIONS;
const LOW = { thresholdTokens: 1, keepRatio: 0.25 };

const text = (content: string): LlmMessage => ({ role: "user", content });
const say = (content: string): LlmMessage => ({ role: "assistant", content });
const calls = (id: string, content = ""): LlmMessage => ({
  role: "assistant",
  content,
  blocks: [{ type: "tool_use", id, name: "open_conversation", input: { id: "1" } }],
});
const answers = (id: string): LlmMessage => ({
  role: "user",
  content: "",
  blocks: [{ type: "tool_result", toolUseId: id, content: "结果" }],
});

// --- when not to compact ---------------------------------------------------

test("a short transcript is left alone", () => {
  assert.equal(planLedgerCompaction([text("一")], LOW), null);
  assert.equal(planLedgerCompaction([], LOW), null);
});

test("a transcript under the threshold is left alone", () => {
  const messages = Array.from({ length: 40 }, (_, i) => text(`第${i}条`));
  assert.equal(planLedgerCompaction(messages, OPTS), null);
});

test("the threshold counts tool blocks, not just prose", () => {
  // A turn whose content is "" but whose tool_result holds a rendered
  // conversation is the bulk of a focus-pipeline transcript.
  const heavy: LlmMessage[] = [
    text("看一下"),
    calls("tu_1"),
    { role: "user", content: "", blocks: [{ type: "tool_result", toolUseId: "tu_1", content: "料".repeat(20_000) }] },
    text("然后呢"),
  ];
  assert.notEqual(
    planLedgerCompaction(heavy, { thresholdTokens: 1_000, keepRatio: 0.25 }),
    null,
    "a transcript this large must be seen as large",
  );
});

// --- where the cut lands ---------------------------------------------------

test("the newest turns are kept and the front is summarized", () => {
  const messages = Array.from({ length: 8 }, (_, i) => text(`第${i}条`));
  const plan = planLedgerCompaction(messages, LOW);
  assert.ok(plan);
  assert.equal(plan.summarize.length + plan.keep.length, messages.length);
  assert.equal(plan.keep.at(-1)?.content, "第7条");
  assert.equal(plan.summarize[0].content, "第0条");
});

test("nothing is lost: the two halves reconstruct the transcript", () => {
  const messages = Array.from({ length: 12 }, (_, i) => text(`第${i}条`));
  const plan = planLedgerCompaction(messages, LOW);
  assert.ok(plan);
  assert.deepEqual([...plan.summarize, ...plan.keep], messages);
});

// --- the cut must never split a tool exchange ------------------------------

test("a cut that would orphan tool_results moves past them", () => {
  // keepRatio would land the cut on the tool_result turn, whose tool_use is in
  // the summarized half — an orphan, and a 400 on the next request.
  const messages = [text("一"), text("二"), calls("tu_1"), answers("tu_1"), text("三")];
  const plan = planLedgerCompaction(messages, { thresholdTokens: 1, keepRatio: 0.4 });
  assert.ok(plan);
  assert.equal(answersToolResultsAtStart(plan.keep), false);
  assert.equal(opensUnansweredAtEnd(plan.summarize), false);
});

test("a cut never leaves a tool_use unanswered in the summarized half", () => {
  for (let keepRatio = 0.05; keepRatio < 0.95; keepRatio += 0.05) {
    const messages = [
      text("一"), calls("tu_1"), answers("tu_1"),
      say("二"), calls("tu_2"), answers("tu_2"),
      text("三"), calls("tu_3"), answers("tu_3"), text("四"),
    ];
    const plan = planLedgerCompaction(messages, { thresholdTokens: 1, keepRatio });
    if (!plan) continue;
    assert.equal(opensUnansweredAtEnd(plan.summarize), false, `keepRatio=${keepRatio.toFixed(2)}`);
    assert.equal(answersToolResultsAtStart(plan.keep), false, `keepRatio=${keepRatio.toFixed(2)}`);
    // And the kept half is a transcript the ledger will accept.
    const ledger = new ConversationLedger();
    ledger.restore(plan.keep);
    assert.deepEqual([...ledger.pendingToolUses], [], `keepRatio=${keepRatio.toFixed(2)}`);
  }
});

test("an untrimmable tail is declined rather than cut badly", () => {
  // The whole tail is one unbroken exchange: settling walks the cut to the end,
  // and summarizing everything would leave no live turn to answer.
  const messages = [calls("tu_1"), answers("tu_1")];
  assert.equal(planLedgerCompaction(messages, { thresholdTokens: 1, keepRatio: 0.05 }), null);
});

test("keepRatio is clamped so a bad config cannot summarize everything", () => {
  const messages = Array.from({ length: 10 }, (_, i) => text(`第${i}条`));
  const tiny = planLedgerCompaction(messages, { thresholdTokens: 1, keepRatio: -5 });
  assert.ok(tiny);
  assert.ok(tiny.keep.length >= 1, "at least one live turn always survives");

  const huge = planLedgerCompaction(messages, { thresholdTokens: 1, keepRatio: 99 });
  assert.ok(huge);
  assert.ok(huge.summarize.length >= 1, "compaction that summarizes nothing is not compaction");
});

// --- the summary prompt ----------------------------------------------------

test("the summary prompt carries tool activity, not just prose", () => {
  const prompt = buildLedgerSummaryPrompt([text("在吗"), calls("tu_1", "我看看"), answers("tu_1")]);
  assert.match(prompt, /在吗/);
  assert.match(prompt, /我看看/);
  assert.match(prompt, /调用 open_conversation/);
  assert.match(prompt, /工具结果/);
});

test("the summary prompt asks for the things a restart must not lose", () => {
  const prompt = buildLedgerSummaryPrompt([text("hi")]);
  assert.match(prompt, /承诺/);
  assert.match(prompt, /当前打开的是哪个会话/);
});

// helpers -------------------------------------------------------------------

function answersToolResultsAtStart(messages: readonly LlmMessage[]): boolean {
  return (messages[0]?.blocks ?? []).some((block) => block.type === "tool_result");
}

function opensUnansweredAtEnd(messages: readonly LlmMessage[]): boolean {
  return (messages.at(-1)?.blocks ?? []).some((block) => block.type === "tool_use");
}

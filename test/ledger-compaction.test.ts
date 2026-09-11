import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LEDGER_COMPACTION_OPTIONS,
  buildLedgerCompactionInstruction,
  buildLedgerCompactionMessages,
  extractLedgerSummary,
  planLedgerCompaction,
  renderLedgerSummaryTurn,
} from "../ledger-compaction.js";
import { ConversationLedger } from "../conversation-ledger.js";
import { buildClaudeRequestBody, type LlmMessage } from "../llm-client.js";
import { QQ_TOOL_DEFINITIONS } from "../qq-tools.js";
import { buildFocusSystemPrompt } from "../focus-prompt.js";

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

// 保留的尾巴从一轮的开头注入开始：整理指令要引用这条注入的原文来标出摘要的边界。
test("the cut lands on the injection that opens a round", () => {
  const messages = [
    text("[通知] 群1 有 1 条新消息"), calls("tu_1", "看看"), answers("tu_1"), say("算了"),
    text("[焦点已切到 群2——有人在群里 @ 了你]"), calls("tu_2"), answers("tu_2"),
    text("[通知] 群3 有 2 条新消息"), calls("tu_3"), answers("tu_3"),
  ];
  for (let keepRatio = 0.05; keepRatio < 0.95; keepRatio += 0.05) {
    const plan = planLedgerCompaction(messages, { thresholdTokens: 1, keepRatio });
    if (!plan) continue;
    assert.equal(plan.keep[0].role, "user", `keepRatio=${keepRatio.toFixed(2)}`);
    assert.match(plan.keep[0].content, /^\[(通知|焦点已切到)/u, `keepRatio=${keepRatio.toFixed(2)}`);
  }
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
  // No round starts after the would-be cut: summarizing everything would leave
  // no live turn to answer.
  assert.equal(planLedgerCompaction([calls("tu_1"), answers("tu_1")], { thresholdTokens: 1, keepRatio: 0.05 }), null);
  assert.equal(planLedgerCompaction([text("一"), calls("tu_1"), answers("tu_1")], { thresholdTokens: 1, keepRatio: 0.05 }), null);
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

// --- the summary call reuses the focus prefix -------------------------------

const LEDGER: LlmMessage[] = [
  text("<conversation_summary>\n## 持续背景\n- 群20000003 禁止复读\n</conversation_summary>"),
  text("[通知] 群20000003 有 1 条新消息,焦点没动:\n  [小明(10000001)] 今天真热啊\n[本轮 current_time: 2026-09-10 18:39 星期四 | 消息来自: 群20000003 | 当前打开: 无]"),
  calls("tu_1", "打开看看"),
  answers("tu_1"),
  say("不接。"),
  text("[焦点已切到 群20000001——有人在群里 @ 了你]\n[09-11 13:00] [小李(10000004)] @Holly 在吗\n[本轮 current_time: 2026-09-11 13:00 星期五 | 消息来自: 群20000001 | 当前打开: 群20000001]"),
  calls("tu_2"),
  answers("tu_2"),
  text("[通知] 群20000002 有 2 条新消息,焦点没动:\n  [某人(1)] 看新闻\n[本轮 current_time: 2026-09-11 13:05 星期五 | 消息来自: 群20000002 | 当前打开: 群20000001]"),
];

test("the compaction request is the ledger unchanged, plus one instruction at the end", () => {
  const plan = planLedgerCompaction(LEDGER, { thresholdTokens: 1, keepRatio: 0.4 });
  assert.ok(plan);
  const messages = buildLedgerCompactionMessages(LEDGER, plan);

  assert.equal(messages.length, LEDGER.length + 1);
  LEDGER.forEach((message, index) => assert.equal(messages[index], message, `message ${index} must be the ledger's own`));
  assert.equal(messages.at(-1)?.role, "user");
  assert.match(messages.at(-1)?.content ?? "", /^<system_reminder>/u);
});

// 这一条钉的是整件事的前提：摘要请求在线上的 system、工具和消息块，必须是焦点循环请求的逐字节
// 延长，否则「复用前缀、命中缓存」只是一句注释。cache_control 不参与缓存键，比较时去掉。
test("the compaction request extends the focus loop's request byte for byte", () => {
  const plan = planLedgerCompaction(LEDGER, { thresholdTokens: 1, keepRatio: 0.4 });
  assert.ok(plan);
  const system = buildFocusSystemPrompt("你是 Holly。").trim();
  const options = { cacheStablePrefix: true, volatileTailMessages: 1, tools: [...QQ_TOOL_DEFINITIONS] };
  const focus = buildClaudeRequestBody("claude-sonnet-4-6", system, LEDGER, options);
  const compaction = buildClaudeRequestBody("claude-sonnet-4-6", system, buildLedgerCompactionMessages(LEDGER, plan), options);

  assert.deepEqual(compaction.tools, focus.tools);
  assert.deepEqual(compaction.system, focus.system);

  const focusBlocks = wireBlocks(focus);
  const compactionBlocks = wireBlocks(compaction);
  assert.equal(compactionBlocks.length, focusBlocks.length + 1, "only the instruction is new");
  assert.deepEqual(compactionBlocks.slice(0, focusBlocks.length), focusBlocks);
  // 焦点请求缓存到的位置，整个落在摘要请求的缓存范围之内。
  assert.ok(breakpointIndex(compaction) >= breakpointIndex(focus));
});

// --- the instruction and the summary turn -----------------------------------

test("the instruction marks where the summary stops by quoting the first kept turn", () => {
  const instruction = buildLedgerCompactionInstruction(LEDGER[5]);
  assert.ok(instruction.includes("「[焦点已切到 群20000001——有人在群里 @ 了你]」"));
  assert.ok(instruction.includes("「[本轮 current_time: 2026-09-11 13:00 星期五 | 消息来自: 群20000001 | 当前打开: 群20000001]」"));
});

test("the instruction asks to merge onto the previous summary rather than rewrite it", () => {
  const instruction = buildLedgerCompactionInstruction(LEDGER[5]);
  assert.match(instruction, /<conversation_summary>/u);
  assert.match(instruction, /基线/u);
  assert.match(instruction, /仍然成立的内容必须保留/u);
  assert.match(instruction, /承诺/u);
  assert.match(instruction, /不要调用任何工具/u);
  // 当前打开的会话每轮注入都会重写，不该占摘要的篇幅。
  assert.match(instruction, /不用记当前打开的是哪个会话/u);
});

test("a summary turn round-trips, and wrappers the model adds are stripped", () => {
  const body = "## 持续背景\n- 群20000003 禁止复读";
  assert.equal(extractLedgerSummary(body), body);
  assert.equal(extractLedgerSummary(`以下是摘要：\n\n${body}`), body);
  assert.equal(extractLedgerSummary(`<conversation_summary>\n${body}\n</conversation_summary>`), body);
  assert.equal(renderLedgerSummaryTurn(`  ${body}  `), `<conversation_summary>\n${body}\n</conversation_summary>`);
});

// helpers -------------------------------------------------------------------

function answersToolResultsAtStart(messages: readonly LlmMessage[]): boolean {
  return (messages[0]?.blocks ?? []).some((block) => block.type === "tool_result");
}

function opensUnansweredAtEnd(messages: readonly LlmMessage[]): boolean {
  return (messages.at(-1)?.blocks ?? []).some((block) => block.type === "tool_use");
}

type WireMessage = { role: string; content: Array<Record<string, unknown>> };

function wireBlocks(body: Record<string, unknown>): Array<{ role: string; block: Record<string, unknown> }> {
  return (body.messages as WireMessage[]).flatMap((message) => message.content.map((block) => {
    const { cache_control: _ignored, ...rest } = block;
    return { role: message.role, block: rest };
  }));
}

function breakpointIndex(body: Record<string, unknown>): number {
  let index = -1;
  (body.messages as WireMessage[]).flatMap((message) => message.content).forEach((block, position) => {
    if (block.cache_control) index = position;
  });
  return index;
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LEDGER_COMPACTION_OPTIONS,
  LEDGER_COMPACTION_SYSTEM_PROMPT,
  buildLedgerCompactionInstruction,
  buildLedgerCompactionMessages,
  buildStaleLedgerSummaryMessages,
  extractLedgerSummary,
  planLedgerCompaction,
  renderLedgerSummaryTurn,
} from "../ledger-compaction.js";
import * as compactionModule from "../ledger-compaction.js";
import { ConversationLedger } from "../conversation-ledger.js";
import { buildCodexRequestBody, digestCodexCachedPrefix, type LlmMessage } from "../llm-client.js";
import { CachePrefixTracker } from "../cache-prefix.js";
import { FOCUS_TOOL_DEFINITIONS } from "../qq-tools.js";
import { buildFocusSystemPrompt } from "../focus-prompt.js";
import { estimateMessagesTokens } from "../context-budget.js";

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

test("an oversized transcript plans one full cut with bounded summary requests and no encrypted reasoning", async () => {
  const messages: LlmMessage[] = Array.from({ length: 24 }, (_, i) => [
    text(`round-${i}: ${"历史事实 ".repeat(300)}`),
    {
      role: "assistant" as const,
      content: `completed-${i}`,
      responseItems: [{ type: "reasoning", encrypted_content: "opaque-reasoning".repeat(2000) }],
    },
  ]).flat();
  const options = { thresholdTokens: 2_000, keepRatio: 0.25, maxSummaryTokens: 6_000 };
  const plan = planLedgerCompaction(messages, options);
  assert.ok(plan);
  assert.equal(plan.summarize.length, messages.length - 2, "plan through the low-water mark, independent of the per-request budget");
  assert.equal(plan.keep[0].role, "user");
  assert.deepEqual([...plan.summarize, ...plan.keep], messages, "batching cannot drop historical turns");

  const ledger = new ConversationLedger();
  ledger.restore(messages);
  const compactor = new compactionModule.LedgerCompactor();
  let requests = 0;
  for (let i = 0; i < 100; i++) {
    const result = await compactor.compact(ledger, async (request) => {
      requests++;
      assert.ok(estimateMessagesTokens(request) <= options.maxSummaryTokens);
      const wire = JSON.stringify(buildCodexRequestBody("gpt-6.1-sol", "summarize", request));
      assert.doesNotMatch(wire, /opaque-reasoning/);
      return "## 持续背景\n- 保留累计历史事实";
    }, options);
    if (result.status === "compacted") break;
    assert.equal(result.status, "progress");
    assert.deepEqual(ledger.snapshot(), messages, "every slice must finish before replacing history");
  }
  assert.ok(requests > 1);
  assert.deepEqual(ledger.snapshot().slice(1), plan.keep);
});

test("multi-round compaction preserves the cache prefix until one final replacement creates headroom", async () => {
  const ledger = new ConversationLedger();
  ledger.restore([
    text(renderLedgerSummaryTurn("## 持续背景\n- FACT-BASE: an unfinished promise")),
    ...Array.from({ length: 12 }, (_, i) => [
      text(`FACT-${i}: ${"历史材料".repeat(200)}`), say(`round-${i} complete`),
    ]).flat(),
  ]);
  const options = { thresholdTokens: 4_000, keepRatio: 0.25, maxSummaryTokens: 4_000 };
  const original = [...ledger.snapshot()];
  const plan = planLedgerCompaction(original, options);
  assert.ok(plan);
  const compactor = new compactionModule.LedgerCompactor();
  const tracker = new CachePrefixTracker();
  const inspect = () => tracker.inspect("focus-ledger", digestCodexCachedPrefix(buildCodexRequestBody(
    "gpt-6.1-sol", "stable persona", [...ledger.snapshot()],
    { tools: [...FOCUS_TOOL_DEFINITIONS], volatileTailMessages: 1 },
  ))).status;
  assert.equal(inspect(), "fresh");
  const sources: string[] = [];
  const arriving: LlmMessage[] = [];
  let lastSummary = "";
  let completed = false;
  let requests = 0;
  for (let i = 0; i < 100; i++) {
    const result = await compactor.compact(ledger, async (request) => {
      requests++;
      assert.ok(estimateMessagesTokens(request) <= options.maxSummaryTokens);
      if (lastSummary) assert.ok(request[0].content.includes(lastSummary), "carry the previous slice's summary forward");
      sources.push(request[0].content.match(/<historical_transcript>\n([\s\S]*)\n<\/historical_transcript>/u)![1]);
      const facts = [...new Set(sources.join("").match(/FACT-(?:BASE|\d+)/gu))];
      lastSummary = `## 持续背景\n- ${facts.join(", ")}`;
      return lastSummary;
    }, options);
    if (result.status === "compacted") {
      completed = true;
      assert.equal(inspect(), "rebuilt");
      break;
    }
    assert.equal(result.status, "progress", "small summary requests must not cause repeated prefix replacements");
    assert.equal(inspect(), "unchanged");
    assert.deepEqual(ledger.snapshot(), [...original, ...arriving]);
    const incoming = text(`message arriving during slice ${i}`);
    ledger.appendUserText(incoming.content);
    arriving.push(ledger.snapshot().at(-1)!);
    assert.equal(inspect(), "extended");
  }
  assert.equal(completed, true);
  assert.ok(requests > 1);
  for (const message of plan.summarize) {
    const fact = message.content.match(/FACT-(?:BASE|\d+)/u)?.[0];
    if (fact) assert.ok(sources.join("").includes(fact), `summarize ${fact} before discarding its source`);
  }
  assert.match(ledger.snapshot()[0].content, /FACT-BASE/);
  assert.deepEqual(ledger.snapshot().slice(1), [...plan.keep, ...arriving]);
  assert.deepEqual(ledger.pendingToolUses, []);
  assert.ok(estimateMessagesTokens(ledger.snapshot()) < options.thresholdTokens, "finished compaction leaves room for new turns");
  assert.equal((await compactor.compact(ledger, async () => { throw new Error("must not immediately compact again"); }, options)).status, "not-needed");
});

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

// --- summary requests carry bounded historical facts ------------------------

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

test("the summary contains prefix facts and tool results while leaving the live tail out", () => {
  const plan = planLedgerCompaction(LEDGER, { thresholdTokens: 1, keepRatio: 0.4 });
  assert.ok(plan);
  const messages = buildLedgerCompactionMessages(LEDGER, plan);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /群20000003 禁止复读/);
  assert.match(messages[0].content, /工具调用 open_conversation/);
  assert.match(messages[0].content, /工具结果 \(tu_1\): 结果/);
  assert.doesNotMatch(messages[0].content, /看新闻/);
});

test("the independent summary request cannot execute historical tools", () => {
  const plan = planLedgerCompaction(LEDGER, { thresholdTokens: 1, keepRatio: 0.4 });
  assert.ok(plan);
  const body = buildCodexRequestBody("gpt-6.1-sol", LEDGER_COMPACTION_SYSTEM_PROMPT, buildLedgerCompactionMessages(LEDGER, plan));
  assert.equal(body.tools, undefined);
  assert.ok(wireInput(body).every((item) => item.role === "user"));
  assert.match(String(wireInput(body)[0].content), /工具调用 open_conversation/);
});

test("summary attempts on their own cache route leave an unchanged focus prefix intact", () => {
  const plan = planLedgerCompaction(LEDGER, { thresholdTokens: 1, keepRatio: 0.4 });
  assert.ok(plan);
  const system = buildFocusSystemPrompt("你是 Holly。").trim();
  const options = { volatileTailMessages: 1, tools: [...FOCUS_TOOL_DEFINITIONS] };
  const tracker = new CachePrefixTracker();
  const inspect = (messages: LlmMessage[], route = "focus-ledger") => tracker.inspect(
    `gpt-6.1-sol|${route}`,
    digestCodexCachedPrefix(buildCodexRequestBody("gpt-6.1-sol", system, messages, options)),
  ).status;

  assert.equal(inspect(LEDGER), "fresh");
  assert.equal(inspect(buildLedgerCompactionMessages(LEDGER, plan), "ledger-compaction"), "fresh");
  assert.equal(inspect(LEDGER), "unchanged");
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

// --- a stale ledger is summarized whole ------------------------------------

test("a stale transcript is summarized whole, after dropping a trailing unanswered tool call", () => {
  const messages = buildStaleLedgerSummaryMessages([...LEDGER, calls("tu_9", "再看看")]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /今天真热啊/);
  assert.match(messages[0].content, /看新闻/);
  assert.doesNotMatch(messages[0].content, /tu_9|再看看/);

  const instruction = messages.at(-1)?.content ?? "";
  assert.match(instruction, /上面的全部内容/u);
  assert.match(instruction, /按已经过去的事来写/u);
  assert.match(instruction, /基线/u);
  assert.doesNotMatch(instruction, /到下面这条消息之前/u);
});

test("a stale transcript with nothing settled left has nothing to summarize", () => {
  assert.throws(() => buildStaleLedgerSummaryMessages([calls("tu_1")]), /nothing left to summarize/u);
});

test("a failed summary keeps every turn and defers further attempts until the retry window", async () => {
  assert.equal(typeof compactionModule.LedgerCompactor, "function");
  let now = 1_000_000;
  const compactor = new compactionModule.LedgerCompactor({ now: () => now, retryMs: 1000 });
  const ledger = new ConversationLedger();
  ledger.restore(Array.from({ length: 12 }, (_, i) => text(`fact-${i}: ${"背景".repeat(100)}`)));
  const before = [...ledger.snapshot()];
  let attempts = 0;
  const summarize = async () => {
    if (++attempts === 1) throw new Error("fetch failed");
    return "## 持续背景\n- 已整理历史事实";
  };
  await assert.rejects(compactor.compact(ledger, summarize, LOW), /fetch failed/);
  assert.deepEqual(ledger.snapshot(), before);
  now += 999;
  assert.equal((await compactor.compact(ledger, summarize, LOW)).status, "deferred");
  assert.equal(attempts, 1);
  now += 1;
  assert.equal((await compactor.compact(ledger, summarize, LOW)).status, "compacted");
  assert.equal(attempts, 2);
  assert.ok(ledger.size < before.length);
  assert.deepEqual(ledger.pendingToolUses, []);
});

test("an empty summary cannot discard history", async () => {
  assert.equal(typeof compactionModule.LedgerCompactor, "function");
  const ledger = new ConversationLedger();
  ledger.restore([text("背景".repeat(100)), text("当前这一轮")]);
  const before = [...ledger.snapshot()];
  const compactor = new compactionModule.LedgerCompactor();
  await assert.rejects(compactor.compact(ledger, async () => "  ", LOW), /empty/i);
  assert.deepEqual(ledger.snapshot(), before);
});

test("one oversized tool round advances in bounded stages and retains its originals until every slice is summarized", async () => {
  const ledger = new ConversationLedger();
  const messages: LlmMessage[] = [text("FACT-A: an unfinished promise")];
  for (let i = 0; i < 5; i++) {
    messages.push(calls(`large-${i}`), {
      role: "user", content: "",
      blocks: [{ type: "tool_result", toolUseId: `large-${i}`, content: `${"材料".repeat(4000)}${i === 4 ? " FACT-Z: the final source fact" : ""}` }],
    });
  }
  messages.push(say("the tool round is settled"), text("CURRENT: a later conversation"));
  ledger.restore(messages);
  const before = [...ledger.snapshot()];
  const compactor = new compactionModule.LedgerCompactor();
  const seenFacts = new Set<string>();
  let requests = 0;
  let complete = false;
  for (let i = 0; i < 100; i++) {
    const result = await compactor.compact(ledger, async (input) => {
      requests++;
      assert.ok(JSON.stringify(input).length < 12_000, "even a single large tool round must stay bounded");
      for (const fact of ["FACT-A", "FACT-Z"]) if (input[0].content.includes(fact)) seenFacts.add(fact);
      return "## 持续背景\n- " + [...seenFacts].join(", ");
    }, { thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000 });
    if (result.status === "compacted") { complete = true; break; }
    assert.equal(result.status, "progress");
    assert.deepEqual(ledger.snapshot(), before, "partial work cannot delete the original round");
  }
  assert.equal(complete, true);
  assert.ok(requests > 1);
  assert.deepEqual([...seenFacts].sort(), ["FACT-A", "FACT-Z"]);
  assert.match(ledger.snapshot()[0].content, /FACT-A.*FACT-Z/s);
  assert.equal(ledger.snapshot().at(-1)?.content, "CURRENT: a later conversation");
  assert.deepEqual(ledger.pendingToolUses, []);
});

test("a network failure retries the same unread source after backoff without losing earlier progress", async () => {
  let now = 1_000_000;
  const ledger = new ConversationLedger();
  ledger.restore([text("long-round: " + "事实 ".repeat(6000)), text("live-tail")]);
  const original = [...ledger.snapshot()];
  const compactor = new compactionModule.LedgerCompactor({ now: () => now, retryMs: 1000 });
  const options = { thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000 };
  assert.equal((await compactor.compact(ledger, async () => "## 持续背景\n- first-slice-fact", options)).status, "progress");
  let failedRequest = "";
  await assert.rejects(compactor.compact(ledger, async (request) => {
    failedRequest = request[0].content;
    throw new Error("fetch failed");
  }, options), /fetch failed/);
  assert.deepEqual(ledger.snapshot(), original);
  assert.equal((await compactor.compact(ledger, async () => { throw new Error("must wait"); }, options)).status, "deferred");
  now += 1000;
  await compactor.compact(ledger, async (request) => {
    assert.equal(request[0].content, failedRequest);
    assert.match(request[0].content, /first-slice-fact/);
    return "## 持续背景\n- first-slice-fact and more";
  }, options);
});

test("a timed out slice shrinks on retry and still summarizes every source character", async () => {
  let now = 1000;
  const ledger = new ConversationLedger();
  ledger.restore([text("FACT-FIRST: " + "历史材料 ".repeat(6000) + " FACT-LAST"), text("live-tail")]);
  const original = [...ledger.snapshot()];
  const options = { thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000 };
  const compactor = new compactionModule.LedgerCompactor({ now: () => now, retryMs: 1000 });
  const source = (request: LlmMessage[]) => request[0].content.match(/<historical_transcript>\n([\s\S]*)\n<\/historical_transcript>/u)![1];
  let failedSource = "";
  await assert.rejects(compactor.compact(ledger, async (request) => {
    failedSource = source(request);
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }, options), /timeout/);
  assert.deepEqual(ledger.snapshot(), original);
  now += 1000;
  const consumed: string[] = [];
  let complete = false;
  for (let i = 0; i < 100; i++) {
    const result = await compactor.compact(ledger, async (request) => {
      const chunk = source(request);
      assert.ok(chunk.length < failedSource.length, "do not replay the same oversized timed-out slice");
      consumed.push(chunk);
      return "## 持续背景\n- FACT-FIRST and FACT-LAST retained";
    }, options);
    if (result.status === "compacted") { complete = true; break; }
    assert.equal(result.status, "progress");
    assert.deepEqual(ledger.snapshot(), original);
  }
  assert.equal(complete, true);
  assert.equal(consumed.join(""), `[历史 user]\n${original[0].content}`);
  assert.equal(ledger.snapshot().at(-1)?.content, "live-tail");
});

test("preparing an oversized ledger finishes all summary slices before it permits a focus request", async () => {
  const ledger = new ConversationLedger();
  ledger.restore([text("old facts ".repeat(6000)), text("live-tail")]);
  const compactor = new compactionModule.LedgerCompactor();
  let slices = 0;
  const result = await compactor.prepare(ledger, async () => {
    slices++;
    return "## 持续背景\n- old facts retained";
  }, { thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000 });
  assert.equal(result.ready, true);
  assert.equal(result.compacted, true);
  assert.ok(slices > 1);
  assert.ok(estimateMessagesTokens(ledger.snapshot()) <= 1000);
  assert.equal(ledger.snapshot().at(-1)?.content, "live-tail");
});

test("a failed preparation cannot permit an oversized request during compaction backoff", async () => {
  const ledger = new ConversationLedger();
  ledger.restore([text("old facts ".repeat(6000)), text("live-tail")]);
  const original = [...ledger.snapshot()];
  const compactor = new compactionModule.LedgerCompactor({ now: () => 1000 });
  const options = { thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000 };
  await assert.rejects(compactor.prepare(ledger, async () => { throw new Error("fetch failed"); }, options), /fetch failed/);
  const result = await compactor.prepare(ledger, async () => { throw new Error("must respect backoff"); }, options);
  assert.equal(result.ready, false);
  assert.deepEqual(ledger.snapshot(), original);
});

test("preparation yields between slices for incoming messages without permitting the oversized request", async () => {
  const ledger = new ConversationLedger();
  ledger.restore([text("old facts ".repeat(6000)), text("live-tail")]);
  const original = [...ledger.snapshot()];
  const compactor = new compactionModule.LedgerCompactor();
  let slices = 0;
  const result = await compactor.prepare(ledger, async () => {
    slices++;
    return "## 持续背景\n- old facts retained";
  }, { thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000 }, { shouldYield: () => true });
  assert.equal(result.ready, false);
  assert.equal(slices, 1);
  assert.deepEqual(ledger.snapshot(), original);
  const resumed = await compactor.prepare(ledger, async () => "## 持续背景\n- old facts retained", {
    thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000,
  });
  assert.equal(resumed.ready, true);
  assert.equal(resumed.compacted, true);
});

test("a confirmed summary preserves new rounds appended while it was being generated", async () => {
  const ledger = new ConversationLedger();
  ledger.restore([text("old-facts ".repeat(1000)), text("original-live-tail")]);
  const result = await new compactionModule.LedgerCompactor().compact(ledger, async () => {
    ledger.appendUserText("newly-arrived-round");
    return "## 持续背景\n- old facts retained";
  }, LOW);
  assert.equal(result.status, "compacted");
  assert.deepEqual(ledger.snapshot().slice(1).map((message) => message.content), ["original-live-tail", "newly-arrived-round"]);
});

test("an existing cumulative summary cannot hide the oversized original round behind it", async () => {
  const ledger = new ConversationLedger();
  ledger.restore([
    text(renderLedgerSummaryTurn("## 持续背景\n- old fact")),
    text("new-round-fact: " + "历史材料 ".repeat(6000)),
    say("settled"), text("live-tail"),
  ]);
  const options = { thresholdTokens: 1000, keepRatio: 0.25, maxSummaryTokens: 4000 };
  const plan = planLedgerCompaction(ledger.snapshot(), options);
  assert.ok(plan && plan.summarize.length > 1, "the batch must consume original history instead of only rewriting its old summary");
  const compactor = new compactionModule.LedgerCompactor();
  let complete = false;
  for (let i = 0; i < 100; i++) {
    const result = await compactor.compact(ledger, async () => "## 持续背景\n- old fact and new-round-fact", options);
    if (result.status === "compacted") { complete = true; break; }
    assert.equal(result.status, "progress");
  }
  assert.equal(complete, true);
  assert.equal(ledger.snapshot().at(-1)?.content, "live-tail");
});

test("stale recovery can stage its sole oversized settled round without preserving a nonexistent live tail", async () => {
  const ledger = new ConversationLedger();
  ledger.restore([text("old complete round: " + "历史材料 ".repeat(6000))]);
  const original = [...ledger.snapshot()];
  const compactor = new compactionModule.LedgerCompactor();
  let complete = false;
  for (let i = 0; i < 100; i++) {
    const result = await compactor.compact(ledger, async () => "## 持续背景\n- preserved stale facts", {
      thresholdTokens: 1, keepRatio: 0.25, maxSummaryTokens: 4000, summarizeAll: true,
    });
    if (result.status === "compacted") { complete = true; break; }
    assert.equal(result.status, "progress");
    assert.deepEqual(ledger.snapshot(), original);
  }
  assert.equal(complete, true);
  assert.equal(ledger.size, 1);
  assert.match(ledger.snapshot()[0].content, /preserved stale facts/);
});

// helpers -------------------------------------------------------------------

function answersToolResultsAtStart(messages: readonly LlmMessage[]): boolean {
  return (messages[0]?.blocks ?? []).some((block) => block.type === "tool_result");
}

function opensUnansweredAtEnd(messages: readonly LlmMessage[]): boolean {
  return (messages.at(-1)?.blocks ?? []).some((block) => block.type === "tool_use");
}

function wireInput(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.input as Array<Record<string, unknown>>;
}

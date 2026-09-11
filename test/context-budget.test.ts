import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compactTextToTokenBudget,
  compressMemoryPrompt,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateRequestTokens,
  estimateSystemPromptTokens,
  estimateTextTokens,
  formatTopicTimestamp,
  modelContextWindowTokens,
  normalizeMessageContent,
  sanitizeConversationMessages,
} from "../context-budget.js";

// Characterization tests: they pin the behaviour this code had when it was
// extracted from main.ts. This is budget arithmetic whose failures are silent
// — a wrong number here quietly truncates conversation context rather than
// throwing — so the point is to notice when any of it moves.

// --- estimateTextTokens ---

test("estimateTextTokens treats blank input as zero", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("   "), 0);
});

test("estimateTextTokens counts an ASCII run as one token per four characters", () => {
  // Lengths chosen to be exact multiples of four: a run of 8 is 2 tokens and
  // not 3, which is what pins the divisor rather than merely the rounding.
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens("abcdefghijkl"), 3);
  assert.equal(estimateTextTokens("hello"), 2);
  assert.equal(estimateTextTokens("hello world"), 4);
});

test("estimateTextTokens counts each Han character as one token", () => {
  assert.equal(estimateTextTokens("你好"), 2);
  assert.equal(estimateTextTokens("你好world"), 4);
});

test("estimateTextTokens counts each punctuation mark as one token", () => {
  assert.equal(estimateTextTokens("!!!"), 3);
});

test("estimateTextTokens never returns less than one for non-blank input", () => {
  assert.equal(estimateTextTokens("a"), 1);
});

// --- the estimate* family ---

test("estimateSystemPromptTokens adds a 12-token envelope, but not to a blank prompt", () => {
  assert.equal(estimateSystemPromptTokens(""), 0);
  assert.equal(estimateSystemPromptTokens("hi"), 13);
});

test("estimateMessageTokens adds a 6-token envelope per message", () => {
  assert.equal(estimateMessageTokens({ role: "user", content: "hi" }), 7);
});

test("estimateMessagesTokens sums the per-message estimates", () => {
  assert.equal(
    estimateMessagesTokens([
      { role: "user", content: "hi" },
      { role: "user", content: "hi" },
    ]),
    14,
  );
});

test("estimateRequestTokens sums the system prompt and the messages", () => {
  assert.equal(estimateRequestTokens("sys", [{ role: "user", content: "hi" }]), 20);
});

// --- normalizeMessageContent / sanitizeConversationMessages ---

test("normalizeMessageContent collapses runs of blank lines and trims", () => {
  assert.equal(normalizeMessageContent("a\n\n\n\n b  "), "a\n\n b");
});

test("sanitizeConversationMessages drops messages that normalize to nothing", () => {
  assert.deepEqual(
    sanitizeConversationMessages([
      { role: "user", content: " a " },
      { role: "user", content: "  " },
    ]),
    [{ role: "user", content: "a" }],
  );
});

// --- compactTextToTokenBudget ---

test("compactTextToTokenBudget leaves text that already fits", () => {
  assert.equal(compactTextToTokenBudget("hello world", 100), "hello world");
});

test("compactTextToTokenBudget returns nothing when the budget is zero or less", () => {
  assert.equal(compactTextToTokenBudget("hello world", 0), "");
  assert.equal(compactTextToTokenBudget("hello world", -1), "");
});

test("compactTextToTokenBudget truncates with an ellipsis and respects the budget", () => {
  const out = compactTextToTokenBudget("一二三四五六七八九十", 3);
  assert.ok(out.endsWith("..."), `expected an ellipsis, got ${JSON.stringify(out)}`);
  assert.ok(out.length < "一二三四五六七八九十".length);
});

// --- compressMemoryPrompt ---

test("compressMemoryPrompt leaves a prompt that already fits", () => {
  assert.equal(compressMemoryPrompt("short", 1000), "short");
});

// 记忆块现在拿的是一份固定配额（main.ts 的 MEMORY_PROMPT_BUDGET_TOKENS），不再
// 和历史共享一个总预算按占比切分。这条不变量是那个改动的支点：只要记忆压缩后
// 一定落在自己的配额里，检索命中多少条就不会挤到历史，历史窗口的起点也就不会
// 跟着每次请求平移——而窗口起点决定了被缓存的前缀长什么样。
test("compressMemoryPrompt stays inside its budget no matter how much it is given", () => {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `[2026-09-09T06:00:00Z] sender=某人(${index}) 一段足够长的记忆内容，用来把预算撑破。`,
  ).join("\n");

  for (const budget of [24, 48, 120, 400, 1000]) {
    const out = compressMemoryPrompt(lines, budget);
    assert.ok(
      estimateTextTokens(out) <= budget,
      `budget=${budget} 却压出了 ${estimateTextTokens(out)} tokens`,
    );
  }
});

test("compressMemoryPrompt yields nothing when it has no budget at all", () => {
  assert.equal(compressMemoryPrompt("[x] anything", 0), "");
  assert.equal(compressMemoryPrompt("[x] anything", -5), "");
});

// --- formatTopicTimestamp ---

test("formatTopicTimestamp renders a missing timestamp as ??", () => {
  assert.equal(formatTopicTimestamp(null), "??");
});

test("formatTopicTimestamp renders a timestamp as MM-DD HH:mm", () => {
  // Deliberately a shape assertion, not an exact string: the output is
  // rendered in local time, and CI runs in UTC while development does not.
  assert.match(formatTopicTimestamp(0), /^\d{2}-\d{2} \d{2}:\d{2}$/);
});

// --- modelContextWindowTokens ---

test("modelContextWindowTokens gives Haiku a 200K window and everything else 1M", () => {
  assert.equal(modelContextWindowTokens("claude-haiku-4-5"), 200_000);
  assert.equal(modelContextWindowTokens("HAIKU"), 200_000);
  assert.equal(modelContextWindowTokens("claude-opus-5"), 1_000_000);
  assert.equal(modelContextWindowTokens(""), 1_000_000);
});

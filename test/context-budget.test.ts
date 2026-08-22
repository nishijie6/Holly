import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allocateVariableContextBudgets,
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

// --- formatTopicTimestamp ---

test("formatTopicTimestamp renders a missing timestamp as ??", () => {
  assert.equal(formatTopicTimestamp(null), "??");
});

test("formatTopicTimestamp renders a timestamp as MM-DD HH:mm", () => {
  // Deliberately a shape assertion, not an exact string: the output is
  // rendered in local time, and CI runs in UTC while development does not.
  assert.match(formatTopicTimestamp(0), /^\d{2}-\d{2} \d{2}:\d{2}$/);
});

// --- allocateVariableContextBudgets ---

test("allocateVariableContextBudgets gives nothing away when there is no budget", () => {
  assert.deepEqual(allocateVariableContextBudgets(0, 0, 0), {
    memoryBudget: 0,
    conversationBudget: 0,
  });
});

test("allocateVariableContextBudgets gives the whole budget to the only claimant", () => {
  assert.deepEqual(allocateVariableContextBudgets(0, 100, 1000), {
    memoryBudget: 0,
    conversationBudget: 1000,
  });
  assert.deepEqual(allocateVariableContextBudgets(100, 0, 1000), {
    memoryBudget: 1000,
    conversationBudget: 0,
  });
});

test("allocateVariableContextBudgets splits proportionally", () => {
  assert.deepEqual(allocateVariableContextBudgets(500, 500, 1000), {
    memoryBudget: 500,
    conversationBudget: 500,
  });
});

test("allocateVariableContextBudgets floors a starved section at 48 tokens", () => {
  assert.deepEqual(allocateVariableContextBudgets(1, 999, 1000), {
    memoryBudget: 48,
    conversationBudget: 952,
  });
});

test("allocateVariableContextBudgets caps the floor at a quarter of a small budget", () => {
  // With totalBudget=100 the floor is min(48, 25) = 25, not 48.
  assert.deepEqual(allocateVariableContextBudgets(1, 999, 100), {
    memoryBudget: 25,
    conversationBudget: 75,
  });
});

test("allocateVariableContextBudgets never exceeds the total budget", () => {
  for (const [m, c, total] of [
    [1, 999, 1000],
    [500, 500, 1000],
    [1, 999, 100],
    [999, 1, 640],
    [7, 3, 64],
  ] as const) {
    const out = allocateVariableContextBudgets(m, c, total);
    assert.ok(
      out.memoryBudget + out.conversationBudget <= total,
      `${m}/${c}/${total} allocated ${out.memoryBudget}+${out.conversationBudget}`,
    );
  }
});

// --- modelContextWindowTokens ---

test("modelContextWindowTokens gives Haiku a 200K window and everything else 1M", () => {
  assert.equal(modelContextWindowTokens("claude-haiku-4-5"), 200_000);
  assert.equal(modelContextWindowTokens("HAIKU"), 200_000);
  assert.equal(modelContextWindowTokens("claude-opus-5"), 1_000_000);
  assert.equal(modelContextWindowTokens(""), 1_000_000);
});

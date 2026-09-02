import assert from "node:assert/strict";
import test from "node:test";

import type { ModelDecision } from "../model-decision.js";

type ReplyRoutingModule = {
  appendRetryFeedbackToVolatileTail(
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    feedback: readonly string[],
  ): Array<{ role: "user" | "assistant" | "system"; content: string }>;
  refineDecisionReply(input: {
    decision: ModelDecision;
    decisionModel: string;
    responseModel: string;
    generateFinalAnswer: (input: {
      systemPrompt: string;
      messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    }) => Promise<string>;
  }): Promise<{
    decision: ModelDecision;
    responseModel: string;
    usedFallback: boolean;
    error: string | null;
  }>;
};

async function routingModule(): Promise<ReplyRoutingModule> {
  const candidate = await import("../reply-routing.js").catch(() => null);
  assert.ok(candidate, "reply-routing module must exist");
  return candidate as unknown as ReplyRoutingModule;
}

function decision(overrides: Partial<ModelDecision> = {}): ModelDecision {
  return {
    shouldReply: true,
    finalAnswer: "我觉得这个结论还需要再核对一下。",
    thinkingProcess: "对方明确问了 Holly 的看法。",
    adminActionStatus: null,
    adminActionReason: "",
    raw: "{}",
    ...overrides,
  };
}

test("silent decisions never invoke the response model", async () => {
  const { refineDecisionReply } = await routingModule();
  let calls = 0;
  const original = decision({ shouldReply: false, finalAnswer: "" });

  const result = await refineDecisionReply({
    decision: original,
    decisionModel: "claude-sonnet-4-6",
    responseModel: "claude-opus-4-7",
    generateFinalAnswer: async () => {
      calls += 1;
      return "不应生成";
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.decision, original);
  assert.equal(result.responseModel, "claude-sonnet-4-6");
});

test("a sendable Sonnet draft is refined once by the distinct response model", async () => {
  const { refineDecisionReply } = await routingModule();
  let seenDraft = "";
  const result = await refineDecisionReply({
    decision: decision(),
    decisionModel: "claude-sonnet-4-6",
    responseModel: "claude-opus-4-7",
    generateFinalAnswer: async (input) => {
      seenDraft = input.messages[0].content;
      return "最终回复：我觉得这个结论最好再核对一下。";
    },
  });

  assert.match(seenDraft, /我觉得这个结论还需要再核对一下/);
  assert.equal(result.decision.finalAnswer, "我觉得这个结论最好再核对一下。");
  assert.equal(result.responseModel, "claude-opus-4-7");
  assert.equal(result.usedFallback, false);
  assert.equal(result.error, null);
});

test("the decision draft is used directly when both roles use the same model", async () => {
  const { refineDecisionReply } = await routingModule();
  let calls = 0;
  const original = decision();
  const result = await refineDecisionReply({
    decision: original,
    decisionModel: "claude-sonnet-4-6",
    responseModel: "claude-sonnet-4-6",
    generateFinalAnswer: async () => {
      calls += 1;
      return "不应生成";
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.decision, original);
  assert.equal(result.responseModel, "claude-sonnet-4-6");
});

test("an empty, incomplete, or failed response-model result falls back to the decision draft", async () => {
  const { refineDecisionReply } = await routingModule();
  const original = decision();

  for (const generateFinalAnswer of [
    async () => "",
    async () => "我觉得因为",
    async () => { throw new Error("response model unavailable"); },
  ]) {
    const result = await refineDecisionReply({
      decision: original,
      decisionModel: "claude-sonnet-4-6",
      responseModel: "claude-opus-4-7",
      generateFinalAnswer,
    });
    assert.equal(result.decision.finalAnswer, original.finalAnswer);
    assert.equal(result.usedFallback, true);
    assert.notEqual(result.error, null);
  }
});

test("retry feedback stays inside the existing volatile tail", async () => {
  const { appendRetryFeedbackToVolatileTail } = await routingModule();
  const original = [
    { role: "user" as const, content: "stable history" },
    { role: "user" as const, content: "dynamic batch and memory" },
  ];

  const result = appendRetryFeedbackToVolatileTail(original, ["previous output invalid", "return JSON"]);

  assert.equal(result.length, 2);
  assert.equal(result[0], original[0]);
  assert.equal(result[1].role, "user");
  assert.equal(result[1].content, "dynamic batch and memory\n\nprevious output invalid\nreturn JSON");
  assert.equal(original[1].content, "dynamic batch and memory");
});

test("administrator decisions keep the approved draft without response-model rewriting", async () => {
  const { refineDecisionReply } = await routingModule();
  let calls = 0;
  const original = decision({
    adminActionStatus: "completed",
    adminActionReason: "任务已经执行完成。",
  });
  const result = await refineDecisionReply({
    decision: original,
    decisionModel: "claude-sonnet-4-6",
    responseModel: "claude-opus-4-7",
    generateFinalAnswer: async () => {
      calls += 1;
      return "改写后的管理员承诺";
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.decision, original);
  assert.equal(result.responseModel, "claude-sonnet-4-6");
});

test("structured or meta response-model output falls back to the approved draft", async () => {
  const { refineDecisionReply } = await routingModule();
  const original = decision();

  for (const output of [
    '```json\n{"final_answer":"改写"}\n```',
    '{"final_answer":"改写"}',
    "thinking_process: 先分析\n最终回复：改写。",
  ]) {
    const result = await refineDecisionReply({
      decision: original,
      decisionModel: "claude-sonnet-4-6",
      responseModel: "claude-opus-4-7",
      generateFinalAnswer: async () => output,
    });
    assert.equal(result.decision.finalAnswer, original.finalAnswer);
    assert.equal(result.usedFallback, true);
  }
});

test("response-model rewriting must preserve every URL from the approved draft", async () => {
  const { refineDecisionReply } = await routingModule();
  const original = decision({
    finalAnswer: "可以看这两个来源：https://example.com/a 和 https://example.org/b。",
  });
  const result = await refineDecisionReply({
    decision: original,
    decisionModel: "claude-sonnet-4-6",
    responseModel: "claude-opus-4-7",
    generateFinalAnswer: async () => "可以看这个来源：https://example.com/a。",
  });

  assert.equal(result.decision.finalAnswer, original.finalAnswer);
  assert.equal(result.usedFallback, true);
  assert.match(result.error ?? "", /URL/i);
});
